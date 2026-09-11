const crypto = require('crypto');
const mongoose = require('mongoose');
const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Transaction = require('../models/transactions.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const { sendPaymentReceiptOnce } = require('../utils/emails/receiptDispatcher.js');
const {
  MINOR_UNIT,
  FULL_PAYMENT_TYPES,
  toMinorUnits,
  toMajorUnits,
  planOutstandingMinor,
  planInFlightMinor,
  nextPaymentNumber,
  refreshDueStatus,
  grantCourseAccess,
  creditInstructor,
} = require('../services/coursePaymentService.js');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
// Cap on the money events joined per enrollment. Far above any real payment
// history, and it stops one pathological row from dragging the whole page.
const TIMELINE_LIMIT = 50;

/**
 * Resolves the user whose courses a caller may view payment records for.
 *
 * Admins scope the whole platform. A tutor/provider scopes their own courses.
 * A team member acting for a provider keeps their own JWT while the dashboard
 * shows the provider, so the acting owner arrives explicitly as `ownerId`
 * (mirroring /auth/add-team's ownerId). The member is allowed only when the
 * owner added them, the invitation was accepted, and the membership grants the
 * "View Payments" privilege — and the scope is the owner's courses, never the
 * member's own.
 *
 * Returns `{ ok, status, message, caller, scoper }`.
 */
async function authorizePaymentView(callerId, requestedOwnerId) {
  const caller = await User.findById(callerId).select('role teamMembers');
  if (!caller) {
    return { ok: false, status: 401, message: 'Authentication required' };
  }
  if (caller.role === 'admin') return { ok: true, caller, scoper: caller };

  // The acting owner id normally equals the caller, except when a team member
  // is impersonating the provider that added them.
  const actorId = String(caller._id);
  const ownerId = requestedOwnerId && String(requestedOwnerId) !== actorId
    ? String(requestedOwnerId)
    : actorId;

  // Admin is handled above. Anyone asking for a different owner must be an
  // accepted member of that owner holding the "View Payments" privilege.
  if (ownerId !== actorId) {
    if (caller.role !== 'team_member') {
      return { ok: false, status: 403, message: 'You do not have permission to view these payments' };
    }
    const ownerEntry = (caller.teamMembers || []).find(
      (entry) =>
        String(entry.ownerId) === ownerId && entry.status === 'accepted'
    );
    const granted = ownerEntry && Array.isArray(ownerEntry.privileges)
      && ownerEntry.privileges.some(p => p.value === 'View Payments' && p.checked);
    if (!granted) {
      return { ok: false, status: 403, message: 'You do not have permission to view payments' };
    }
    const owner = await User.findById(ownerId).select('role');
    if (!owner) {
      return { ok: false, status: 404, message: 'Owner not found' };
    }
    // The scope is built from the owner's own role/id.
    return { ok: true, caller, scoper: owner };
  }

  // tutor/provider (and team_member acting on their own record — no courses,
  // so an empty scope) keep the historical behaviour.
  return { ok: true, caller, scoper: caller };
}

/**
 * Who this caller is allowed to see payment records for.
 *
 * Admins see the whole platform. A tutor sees only courses they own or are
 * assigned to — money is course-scoped, so scoping the course match is what
 * scopes the records. Read the role from the stored user, not the token claims,
 * so a demotion takes effect immediately.
 */
function courseScopeFor(caller, courseId) {
  const scope = {};
  if (courseId) scope._id = new mongoose.Types.ObjectId(String(courseId));
  if (caller.role === 'admin') return scope;
  // instructorId/assignedTutors are typed ObjectId, but some legacy course
  // documents stored them as plain strings. Course.aggregate does NOT cast
  // $match values the way Course.find does, so matching only the ObjectId form
  // silently returns zero rows for those string-stored courses — which is
  // exactly how a tutor's whole payments view goes blank. Match both forms.
  return {
    ...scope,
    $or: [
      { instructorId: { $in: [caller._id, String(caller._id)] } },
      { assignedTutors: { $in: [caller._id, String(caller._id)] } },
    ],
  };
}

function parsePagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requested = Number.parseInt(query.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, requested));
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Turns one enrollment into a money row.
 *
 * `expected` comes from the plan's snapshot when there is a plan, because the
 * fee the student agreed to is the one they owe — a later fee edit must not
 * change an outstanding balance. Scholarship places expect nothing by
 * definition, which is what keeps waived seats out of the owed column.
 */
/**
 * Every money event on one enrollment, newest first.
 *
 * This is what makes a repeat payment update a row instead of adding one: the
 * table shows a single (course, student) row whose `paid`/`owed` already include
 * every payment, and the detail modal expands that row into the individual events
 * behind it. Part payments and full payments live in different collections, so
 * they are normalized to a common shape here and merged on time.
 */
function buildTimeline(row, plan, fullPayments, scholarship) {
  const events = [];

  if (row.enrolledOn) {
    events.push({
      kind: 'enrollment',
      label: scholarship ? 'Scholarship place granted' : 'Enrolled on the course',
      amount: 0,
      at: row.enrolledOn,
      status: 'completed',
    });
  }

  fullPayments.forEach((entry) => {
    const offline = String(entry.metadata?.purpose || '').includes('settlement');
    events.push({
      kind: offline ? 'settlement' : 'full',
      label: offline ? 'Balance settled offline' : 'Full payment',
      amount: Number(entry.amount || 0),
      at: entry.paidAt || entry.date || null,
      status: 'completed',
      reference: entry.reference || entry.txRef || null,
      note: entry.metadata?.note || null,
      recordedBy: entry.metadata?.settledByName || null,
    });
  });

  // Only instalments that moved money, or are moving it right now. `pending`
  // entries are intents the student never completed and would read as phantom
  // payments in a timeline.
  (plan?.installments || []).forEach((entry) => {
    if (!['paid', 'processing'].includes(entry.status)) return;
    // An admin recording an offline settlement writes a normal instalment; the
    // txRef is the only marker that survives into the plan document.
    const offline = String(entry.txRef || '').startsWith('admin-settle-');
    events.push({
      kind: offline ? 'settlement' : 'part',
      label: offline
        ? `Balance settled offline (#${entry.number})`
        : entry.status === 'paid'
          ? `Part payment #${entry.number}`
          : `Part payment #${entry.number} in progress`,
      amount: Number(entry.amountMinor || 0) / MINOR_UNIT,
      at: entry.paidAt || entry.lastAttemptAt || null,
      status: entry.status === 'paid' ? 'completed' : 'processing',
      reference: entry.txRef || null,
    });
  });

  // Undated rows sort last rather than jumping to the top as epoch 0.
  return events.sort((a, b) => {
    const left = a.at ? new Date(a.at).getTime() : -Infinity;
    const right = b.at ? new Date(b.at).getTime() : -Infinity;
    return right - left;
  });
}

function buildRecord(row) {
  const student = row.student || {};
  const plan = row.plan || null;
  const scholarship = row.scholarship === true || row.enrollmentStatus === 'scholarship';
  // The admissions tabs split on this flag, so the money rows carry it too —
  // one response then feeds both the payments view and the graduates view.
  const graduate = student.graduate === true;

  const fullPayments = Array.isArray(row.fullPayments) ? row.fullPayments : [];
  const fullPaid = fullPayments.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const fullPaidLastAt = fullPayments.reduce((latest, entry) => {
    const at = entry.paidAt || entry.date;
    if (!at) return latest;
    return !latest || new Date(at) > new Date(latest) ? at : latest;
  }, null);

  const planTotalMinor = Number(plan?.totalAmountMinor || 0);
  const planPaidMinor = Number(plan?.amountPaidMinor || 0);

  const expected = scholarship
    ? 0
    : planTotalMinor > 0
      ? planTotalMinor / MINOR_UNIT
      : Number(row.fee || 0);
  const paid = scholarship ? 0 : Number((fullPaid + planPaidMinor / MINOR_UNIT).toFixed(2));
  const owed = Number(Math.max(0, expected - paid).toFixed(2));

  const method = scholarship
    ? 'scholarship'
    : fullPaid > 0 && planPaidMinor === 0
      ? 'full'
      : planPaidMinor > 0
        ? 'part'
        : 'unpaid';

  const timeline = buildTimeline(row, plan, fullPayments, scholarship);
  const paidEvents = timeline.filter(event => event.status === 'completed' && event.amount > 0);
  const lastPaymentAt = paidEvents[0]?.at
    || plan?.lastPaymentAt
    || fullPaidLastAt
    || null;

  return {
    courseId: row.courseId,
    courseTitle: row.courseTitle,
    instructorName: row.instructorName || null,
    student: {
      id: student._id || row.studentId,
      fullname: student.fullname || 'Unknown student',
      email: student.email || null,
      phone: student.phone || null,
      profilePicture: student.profilePicture || null,
    },
    enrolledOn: row.enrolledOn || null,
    enrollmentStatus: row.enrollmentStatus || 'active',
    method,
    scholarship,
    graduate,
    expected,
    paid,
    owed,
    settled: owed <= 0,
    payments: paidEvents.length,
    timeline,
    planStatus: plan?.status || null,
    planId: plan?._id || null,
    settlementDueAt: plan?.settlementDueAt || null,
    firstPaymentAt: plan?.firstPaymentAt || paidEvents[paidEvents.length - 1]?.at || null,
    lastPaymentAt,
  };
}

/**
 * The aggregation stages shared by the rows query and the totals query.
 *
 * One enrollment becomes one row, joined to that student's live plan and to any
 * settled full payment. Both joins are correlated sub-pipelines rather than a
 * flat localField/foreignField lookup because the match is on the (course,
 * student) pair, not on a single key.
 *
 * Cancelled plans are excluded: an abandoned intent is not a balance, and
 * counting one would show money owed that nobody agreed to pay.
 *
 * Every id comparison is wrapped in $toString because course/plan/transaction
 * ids drifted between ObjectId and string across the data set; comparing raw
 * values silently drops a join whenever the two sides were stored as different
 * BSON types. $toString of two equal ids is the same hex string, so matches are
 * preserved while the type mismatch stops hiding rows.
 */
function recordPipeline(scope) {
  return [
    { $match: scope },
    {
      $project: {
        title: 1,
        fee: 1,
        instructorName: 1,
        enrollments: { $ifNull: ['$enrollments', []] },
      },
    },
    { $unwind: '$enrollments' },
    {
      $lookup: {
        from: 'coursepaymentplans',
        let: { courseId: '$_id', studentId: '$enrollments.user' },
        pipeline: [
          {
            $match: {
              status: { $ne: 'cancelled' },
              $expr: {
                $and: [
                  { $eq: [{ $toString: '$courseId' }, { $toString: '$$courseId' }] },
                  { $eq: [{ $toString: '$userId' }, { $toString: '$$studentId' }] },
                ],
              },
            },
          },
          { $sort: { updatedAt: -1 } },
          { $limit: 1 },
          {
            $project: {
              totalAmountMinor: 1,
              amountPaidMinor: 1,
              status: 1,
              settlementDueAt: 1,
              lastPaymentAt: 1,
              installments: 1,
            },
          },
        ],
        as: 'plan',
      },
    },
    {
      $lookup: {
        from: 'transactions',
        let: { courseId: '$_id', studentId: '$enrollments.user' },
        pipeline: [
          {
            $match: {
              status: 'successful',
              type: { $in: FULL_PAYMENT_TYPES },
              $expr: {
                $and: [
                  { $eq: [{ $toString: '$courseId' }, { $toString: '$$courseId' }] },
                  { $eq: [{ $toString: '$userId' }, { $toString: '$$studentId' }] },
                ],
              },
            },
          },
          // Rows rather than a total: the row modal renders each payment as its
          // own timeline entry, and the total is a sum of the same rows in
          // buildRecord, so the table and the timeline can never disagree.
          { $sort: { paidAt: -1, date: -1 } },
          { $limit: TIMELINE_LIMIT },
          {
            $project: {
              amount: 1,
              paidAt: 1,
              date: 1,
              type: 1,
              reference: 1,
              txRef: 1,
              currency: 1,
              'metadata.purpose': 1,
              'metadata.settledBy': 1,
              'metadata.settledByName': 1,
              'metadata.note': 1,
            },
          },
        ],
        as: 'fullPayments',
      },
    },
    {
      $lookup: {
        from: 'users',
        let: { studentId: '$enrollments.user' },
        pipeline: [
          { $match: { $expr: { $eq: [{ $toString: '$_id' }, { $toString: '$$studentId' }] } } },
          { $project: { fullname: 1, email: 1, phone: 1, profilePicture: 1, graduate: 1 } },
        ],
        as: 'student',
      },
    },
    {
      $project: {
        _id: 0,
        courseId: '$_id',
        courseTitle: '$title',
        instructorName: 1,
        fee: { $ifNull: ['$fee', 0] },
        studentId: '$enrollments.user',
        enrolledOn: '$enrollments.enrolledOn',
        enrollmentStatus: '$enrollments.status',
        scholarship: '$enrollments.scholarship',
        plan: { $first: '$plan' },
        student: { $first: '$student' },
        fullPayments: { $ifNull: ['$fullPayments', []] },
      },
    },
  ];
}

const paymentRecordController = {
  /**
   * Payment records for the admissions view: who is admitted, what they were
   * expected to pay, what landed, and what is still owed.
   *
   * Filtering and totals are computed after the records are built rather than in
   * the pipeline, because "owed" depends on the scholarship and plan-snapshot
   * rules in buildRecord and duplicating that logic in aggregation operators is
   * how the two answers drift apart. The scope is bounded by course ownership,
   * so the working set is a tutor's own enrollments or an admin's course.
   */
  listPaymentRecords: async (req, res) => {
    try {
      const callerId = req.user?.id || req.user?._id;
      const authz = await authorizePaymentView(callerId, req.query.ownerId);
      if (!authz.ok) return res.status(authz.status).json({ message: authz.message });
      const scoper = authz.scoper;

      const { courseId } = req.query;
      if (courseId && !mongoose.Types.ObjectId.isValid(String(courseId))) {
        return res.status(400).json({ message: 'Invalid course id' });
      }

      const rows = await Course.aggregate(recordPipeline(courseScopeFor(scoper, courseId)));
      const records = rows.map(buildRecord);

      // Totals describe the whole scope, not the page — an admin monitoring what
      // is outstanding needs the real figure, not the sum of 25 visible rows.
      const summary = records.reduce((acc, record) => ({
        students: acc.students + 1,
        expected: acc.expected + record.expected,
        paid: acc.paid + record.paid,
        owed: acc.owed + record.owed,
        owing: acc.owing + (record.owed > 0 ? 1 : 0),
        scholarships: acc.scholarships + (record.scholarship ? 1 : 0),
      }), { students: 0, expected: 0, paid: 0, owed: 0, owing: 0, scholarships: 0 });

      const search = String(req.query.search || '').trim().toLowerCase();
      const status = String(req.query.status || 'all').toLowerCase();

      let filtered = records;

      // Exact-user filter behind the admissions Users selector. Kept separate
      // from the free-text search so picking a name from the dropdown cannot be
      // widened by a namesake, and so selecting a user with no enrollment on the
      // caller's courses correctly returns nothing rather than a fuzzy match.
      const studentId = String(req.query.studentId || '').trim();
      if (studentId) {
        if (!mongoose.Types.ObjectId.isValid(studentId)) {
          return res.status(400).json({ message: 'Invalid student id' });
        }
        filtered = filtered.filter(record => String(record.student.id) === studentId);
      }

      if (search) {
        filtered = filtered.filter(record =>
          record.student.fullname.toLowerCase().includes(search)
          || (record.student.email || '').toLowerCase().includes(search)
          || record.courseTitle.toLowerCase().includes(search));
      }
      if (status === 'owing') filtered = filtered.filter(record => record.owed > 0);
      else if (status === 'settled') filtered = filtered.filter(record => record.owed <= 0 && !record.scholarship);
      else if (status === 'scholarship') filtered = filtered.filter(record => record.scholarship);
      else if (status === 'graduate') filtered = filtered.filter(record => record.graduate === true);
      // "My Students" in the admissions view: anyone who has put money down,
      // whether a part payment or the full fee.
      else if (status === 'payers') filtered = filtered.filter(record => record.paid > 0);

      // Most recent payment first: a repeat payment updates its existing row and
      // that row moves to the top, which is what "last payment events should
      // always be first" means for a table of one row per (course, student).
      // Rows nobody has paid on have no payment date, so they fall in behind on
      // enrollment date rather than sorting as epoch 0 at the top.
      const sortBy = String(req.query.sort || 'recent').toLowerCase();
      const time = (value) => (value ? new Date(value).getTime() : 0);
      if (sortBy === 'owed') {
        filtered.sort((a, b) => b.owed - a.owed || time(b.enrolledOn) - time(a.enrolledOn));
      } else if (sortBy === 'name') {
        filtered.sort((a, b) => a.student.fullname.localeCompare(b.student.fullname));
      } else {
        filtered.sort((a, b) =>
          time(b.lastPaymentAt) - time(a.lastPaymentAt)
          || time(b.enrolledOn) - time(a.enrolledOn)
          || b.owed - a.owed);
      }

      const { page, limit, skip } = parsePagination(req.query);
      return res.json({
        records: filtered.slice(skip, skip + limit),
        summary: {
          ...summary,
          expected: Number(summary.expected.toFixed(2)),
          paid: Number(summary.paid.toFixed(2)),
          owed: Number(summary.owed.toFixed(2)),
        },
        pagination: {
          page,
          limit,
          total: filtered.length,
          pages: Math.max(1, Math.ceil(filtered.length / limit)),
        },
      });
    } catch (error) {
      console.error('List payment records failed:', error);
      return res.status(500).json({ message: 'Unable to load payment records' });
    }
  },

  /**
   * The courses the caller may filter payment records by. Backs the course
   * selector so the client never has to guess at a scope the server will reject.
   */
  listPaymentRecordCourses: async (req, res) => {
    try {
      const callerId = req.user?.id || req.user?._id;
      const authz = await authorizePaymentView(callerId, req.query.ownerId);
      if (!authz.ok) return res.status(authz.status).json({ message: authz.message });
      const scoper = authz.scoper;

      // Mirror listPaymentRecords: aggregate (not find) so the type-agnostic
      // scope in courseScopeFor is honored. Course.find would cast the $in
      // elements back to ObjectId and drop string-stored courses, leaving the
      // selector out of step with the records it is meant to filter.
      const courses = await Course.aggregate([
        { $match: courseScopeFor(scoper) },
        { $project: { title: 1, fee: 1, partPaymentEnabled: 1, createdAt: 1 } },
        { $sort: { createdAt: -1 } },
      ]);

      return res.json({
        courses: courses.map(course => ({
          _id: course._id,
          title: course.title,
          fee: Number(course.fee || 0),
          partPaymentEnabled: course.partPaymentEnabled === true,
        })),
      });
    } catch (error) {
      console.error('List payment record courses failed:', error);
      return res.status(500).json({ message: 'Unable to load courses' });
    }
  },

  /**
   * Admin records an offline settlement of a student's outstanding balance.
   *
   * Money collected outside the gateway (bank transfer handed to the admin,
   * cash reconciliation) still has to land in the same ledger the gateway
   * writes to, or the balance the payment records show drifts from reality.
   * This writes a successful `course_installment` transaction and settles it
   * against the plan through the same code path a webhook uses, so idempotency,
   * instructor credit and enrollment all behave identically.
   *
   * The amount is clamped to the outstanding balance: an admin action must not
   * be able to overpay a plan, and the final payment is exempt from the
   * minimum-payment floor by design.
   */
  settleStudentBalance: async (req, res) => {
    try {
      const callerId = req.user?.id || req.user?._id;
      const caller = await User.findById(callerId).select('role');
      if (!caller) return res.status(401).json({ message: 'Authentication required' });
      if (caller.role !== 'admin') return res.status(403).json({ message: 'Only admins may settle a balance' });

      const { courseId, studentId } = req.body;
      if (!mongoose.Types.ObjectId.isValid(String(courseId))) {
        return res.status(400).json({ message: 'Invalid course id' });
      }
      if (!mongoose.Types.ObjectId.isValid(String(studentId))) {
        return res.status(400).json({ message: 'Invalid student id' });
      }

      const [course, student] = await Promise.all([
        Course.findById(courseId).select('title fee instructorId'),
        User.findById(studentId).select('fullname email role'),
      ]);
      if (!course) return res.status(404).json({ message: 'Course not found' });
      if (!student) return res.status(404).json({ message: 'Student not found' });

      const plan = await CoursePaymentPlan.findOne({
        courseId: course._id,
        userId: student._id,
        status: { $ne: 'cancelled' },
      });
      if (!plan) {
        return res.status(404).json({ message: 'This student has no payment plan for this course' });
      }
      if (refreshDueStatus(plan)) await plan.save();

      const outstandingMinor = planOutstandingMinor(plan);
      if (outstandingMinor <= 0) {
        return res.status(409).json({ message: 'This student has no outstanding balance on this course' });
      }

      // Anything already committed to an open checkout is not payable again.
      const inFlightMinor = planInFlightMinor(plan);
      const availableMinor = outstandingMinor - inFlightMinor;
      if (availableMinor <= 0) {
        return res.status(409).json({ message: 'A gateway payment is already in progress for this balance' });
      }

      // An explicit amount is allowed for partial offline settlement, but it is
      // clamped to what is actually owed — the ledger must never go over.
      const requestedMinor = req.body.amount === undefined || req.body.amount === null || req.body.amount === ''
        ? availableMinor
        : toMinorUnits(req.body.amount);
      if (requestedMinor <= 0) {
        return res.status(400).json({ message: 'Invalid settlement amount' });
      }
      const amountMinor = Math.min(requestedMinor, availableMinor);
      const amountMajor = toMajorUnits(amountMinor);

      const paymentNumber = nextPaymentNumber(plan);
      const txRef = `admin-settle-${plan._id}-${paymentNumber}-${crypto.randomUUID()}`;

      const transaction = await Transaction.create({
        userId: student._id,
        courseId: course._id,
        paymentPlanId: plan._id,
        installmentNumber: paymentNumber,
        amount: amountMajor,
        txRef,
        type: 'course_installment',
        status: 'successful',
        currency: plan.currency || 'NGN',
        paidAt: new Date(),
        metadata: {
          title: course.title,
          paymentNumber,
          settledBy: String(callerId),
          purpose: 'admin_balance_settlement',
          offline: true,
        },
      });

      // Same elemMatch-guarded update the webhook finalizer uses: only the first
      // writer flips the payment to paid and increments the plan total, so a
      // retried request cannot double-credit.
      const now = new Date();
      const updatedPlan = await CoursePaymentPlan.findOneAndUpdate(
        { _id: plan._id, installments: { $elemMatch: { number: paymentNumber, status: { $ne: 'paid' } } } },
        {
          $set: {
            'installments.$.status': 'paid',
            'installments.$.amountMinor': amountMinor,
            'installments.$.txRef': txRef,
            'installments.$.paidAt': now,
            status: 'active',
            accessStatus: 'active',
            lastPaymentAt: now,
            firstPaymentAt: plan.firstPaymentAt || now,
            settlementDueAt: plan.settlementDueAt || now,
          },
          $inc: { amountPaidMinor: amountMinor },
        },
        { new: true },
      );

      const currentPlan = updatedPlan || await CoursePaymentPlan.findById(plan._id);
      const isSettled = Number(currentPlan.amountPaidMinor) >= Number(currentPlan.totalAmountMinor);
      if (isSettled && currentPlan.status !== 'completed') {
        currentPlan.status = 'completed';
        currentPlan.accessStatus = 'active';
        await currentPlan.save();
      }

      await grantCourseAccess({ userId: student._id, courseId: course._id, plan: currentPlan });
      if (updatedPlan) {
        await creditInstructor(transaction, amountMajor);
      }

      // Offline settlements write their own transaction row, so the receipt is
      // dispatched here rather than in the gateway finalizer. Fire-and-forget.
      const freshTx = await Transaction.findById(transaction._id);
      if (freshTx) {
        const outstanding = toMajorUnits(planOutstandingMinor(currentPlan));
        sendPaymentReceiptOnce({
          transaction: freshTx,
          user: student,
          course,
          plan: currentPlan,
          settledInFull: isSettled,
          balanceRemaining: outstanding,
          paymentMethod: 'Bank transfer (offline)',
        });
      }

      return res.status(200).json({
        message: isSettled
          ? `Balance settled in full for ${student.fullname}`
          : `Offline payment of ${amountMajor} recorded for ${student.fullname}`,
        settledInFull: isSettled,
        amount: amountMajor,
        outstanding: toMajorUnits(planOutstandingMinor(currentPlan)),
      });
    } catch (error) {
      console.error('Settle student balance failed:', error);
      return res.status(500).json({ message: 'Unable to settle the balance' });
    }
  },
};

module.exports = paymentRecordController;
