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
  return {
    ...scope,
    $or: [
      { instructorId: caller._id },
      { assignedTutors: caller._id },
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
function buildRecord(row) {
  const student = row.student || {};
  const plan = row.plan || null;
  const scholarship = row.scholarship === true || row.enrollmentStatus === 'scholarship';
  // The admissions tabs split on this flag, so the money rows carry it too —
  // one response then feeds both the payments view and the graduates view.
  const graduate = student.graduate === true;

  const planTotalMinor = Number(plan?.totalAmountMinor || 0);
  const planPaidMinor = Number(plan?.amountPaidMinor || 0);
  const fullPaid = Number(row.fullPaidTotal || 0);

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
    payments: (plan?.installments || []).filter(entry => entry.status === 'paid').length
      + (fullPaid > 0 ? 1 : 0),
    planStatus: plan?.status || null,
    settlementDueAt: plan?.settlementDueAt || null,
    lastPaymentAt: plan?.lastPaymentAt || row.fullPaidLastAt || null,
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
                  { $eq: ['$courseId', '$$courseId'] },
                  { $eq: ['$userId', '$$studentId'] },
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
                  { $eq: ['$courseId', '$$courseId'] },
                  { $eq: ['$userId', '$$studentId'] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
              lastAt: { $max: '$paidAt' },
            },
          },
        ],
        as: 'fullPayment',
      },
    },
    {
      $lookup: {
        from: 'users',
        let: { studentId: '$enrollments.user' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$studentId'] } } },
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
        fullPaidTotal: { $ifNull: [{ $first: '$fullPayment.total' }, 0] },
        fullPaidLastAt: { $first: '$fullPayment.lastAt' },
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
      const caller = await User.findById(callerId).select('role');
      if (!caller) return res.status(401).json({ message: 'Authentication required' });

      const { courseId } = req.query;
      if (courseId && !mongoose.Types.ObjectId.isValid(String(courseId))) {
        return res.status(400).json({ message: 'Invalid course id' });
      }

      const rows = await Course.aggregate(recordPipeline(courseScopeFor(caller, courseId)));
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

      // Largest balance first: the rows that need chasing are the point of the view.
      filtered.sort((a, b) => b.owed - a.owed
        || new Date(b.enrolledOn || 0) - new Date(a.enrolledOn || 0));

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
      const caller = await User.findById(callerId).select('role');
      if (!caller) return res.status(401).json({ message: 'Authentication required' });

      const courses = await Course.find(courseScopeFor(caller))
        .select('title fee partPaymentEnabled')
        .sort({ createdAt: -1 })
        .lean();

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
