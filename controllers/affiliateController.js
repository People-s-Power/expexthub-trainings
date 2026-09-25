const mongoose = require('mongoose');
const User = require('../models/user');
const Course = require('../models/courses');
const Transaction = require('../models/transactions');
const Appointment = require('../models/appointment');
const Notification = require('../models/notifications');
const AuditLog = require('../models/auditLog');
const ReferralClick = require('../models/referralClick');
const AffiliateCommission = require('../models/affiliateCommission');
const { executeWithdrawal } = require('../services/withdrawalService.js');
const { generateUniqueAffiliateCode, generateReferralToken } = require('../utils/affiliateIdentity');
const { MAX_COMMISSION_RATE } = require('../services/affiliateCommissionService.js');
const { TUTOR_ONLY } = require('../utils/roles.js');
const { SOCIAL_KEYS } = require('../utils/affiliateApplication.js');
const { normalizeUrl } = require('../utils/normalizeUrl.js');

const LEARNER_ROLES = ['student', 'client'];

// Commission rows store money in minor units (kobo), matching the payment
// tables. The wallet balance and the transaction ledger store major units
// (naira), matching `Transaction.amount` and `User.balance`.
//
// Every money field this module returns is converted to **major units** at the
// edge, so a client never has to know which of two conventions a given field
// used. Mixing the two in one response is exactly how a 100x display error ships.
const MINOR_UNIT = 100;
const toMajor = (minor) => Number((Number(minor || 0) / MINOR_UNIT).toFixed(2));

// Statuses that mean the applicant's journey is over, so the UI can stop
// offering transitions out of them.
const TERMINAL_ADMISSION_STATUSES = ['rejected', 'withdrawn', 'cancelled'];

const ADMISSION_STATUSES = [
  'lead',
  'application_started',
  'application_submitted',
  'under_review',
  'admitted',
  'awaiting_payment',
  'registered',
  'training_started',
  'completed',
  ...TERMINAL_ADMISSION_STATUSES,
];

// --- small helpers -----------------------------------------------------------

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

/** Clamps a page/limit pair so a caller cannot ask for the whole collection. */
function pagination(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function paged(records, total, { page, limit }) {
  return {
    records,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/**
 * Escapes a user-supplied string before it reaches a RegExp.
 *
 * Without this, a search box is a denial-of-service vector: `(` is an invalid
 * pattern that throws, and a crafted pattern can be made to backtrack
 * catastrophically. Every `$regex` search in this controller goes through here.
 */
function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The start of a named period, or null for "all time". */
function periodRange(period, from, to) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  switch (period) {
    case 'today':
      return { $gte: startOfDay(now) };
    case 'week': {
      const start = startOfDay(now);
      // Week starts Monday — `getDay()` returns 0 for Sunday, which would
      // otherwise put Sunday at the start of the following week.
      const offset = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - offset);
      return { $gte: start };
    }
    case 'month':
      return { $gte: new Date(now.getFullYear(), now.getMonth(), 1) };
    case 'year':
      return { $gte: new Date(now.getFullYear(), 0, 1) };
    case 'custom': {
      const range = {};
      const fromDate = from ? new Date(from) : null;
      const toDate = to ? new Date(to) : null;
      if (fromDate && !Number.isNaN(fromDate.getTime())) range.$gte = startOfDay(fromDate);
      if (toDate && !Number.isNaN(toDate.getTime())) {
        // Inclusive of the end day: a "to" of the 5th must include the 5th.
        const end = startOfDay(toDate);
        end.setDate(end.getDate() + 1);
        range.$lt = end;
      }
      return Object.keys(range).length ? range : null;
    }
    default:
      return null;
  }
}

/** Never echo a full account number back to a client. */
function maskAccountNumber(accountNumber) {
  const value = String(accountNumber || '');
  if (!value) return null;
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

function logAudit({ req, action, entity, entityId, before, after, note }) {
  // Fire-and-forget: an audit write must never fail the action it describes, and
  // a missing log entry is far less bad than a refused approval.
  AuditLog.create({
    actor: req.user?.id,
    actorRole: req.user?.role,
    actorName: req.user?.fullName,
    action,
    entity,
    entityId: entityId ? String(entityId) : undefined,
    before,
    after,
    note,
    ip: req.ip,
    userAgent: req.headers?.['user-agent'],
    at: new Date(),
  }).catch((error) => console.error('Audit log write failed:', action, error.message));
}

/**
 * Loads the affiliate behind the request, or null.
 *
 * Every affiliate-scoped query starts here and filters on the returned id, so an
 * id supplied in a URL or body is never trusted — the caller's own id is the only
 * one that decides what they can read or change.
 */
async function requireAffiliate(req, res) {
  if (req.user?.role !== 'affiliate') {
    res.status(403).json({ message: 'Affiliate access required' });
    return null;
  }
  const affiliate = await User.findById(req.user.id);
  if (!affiliate) {
    res.status(404).json({ message: 'Affiliate account not found' });
    return null;
  }
  return affiliate;
}

/** The filter that selects "this affiliate's students". */
function studentScope(affiliateId) {
  return {
    role: { $in: LEARNER_ROLES },
    $or: [{ referredByAffiliate: affiliateId }, { registeredBy: affiliateId }],
  };
}

// --- public endpoints --------------------------------------------------------

/**
 * The affiliate picker on the student signup form.
 *
 * Deliberately public — signup has no session — so it exposes the minimum needed
 * to recognise a name: no email, no phone, no earnings, no student counts. Only
 * approved affiliates are listed, because only they can legitimately be named as
 * a referrer.
 */
exports.directory = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query, { defaultLimit: 20, maxLimit: 50 });
    const search = String(req.query.search || '').trim();

    const filter = { role: 'affiliate', 'affiliateProfile.status': 'approved', blocked: { $ne: true } };
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { fullname: pattern },
        { organizationName: pattern },
        { affiliateId: pattern },
        { affiliateCode: new RegExp(`^${escapeRegex(search)}$`, 'i') },
      ];
    }

    const [rows, total] = await Promise.all([
      User.find(filter)
        .select('fullname organizationName affiliateId affiliateCode affiliateProfile.businessName')
        .sort({ fullname: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const records = rows.map((row) => ({
      id: row._id,
      // The business name is the more recognisable label for an organisation, so
      // it is preferred where it exists.
      name: row.affiliateProfile?.businessName || row.organizationName || row.fullname || 'ExpertHub affiliate',
      affiliateId: row.affiliateId || null,
      affiliateCode: row.affiliateCode || null,
    }));

    return res.json(paged(records, total, { page, limit }));
  } catch (error) {
    console.error('Affiliate directory failed:', error);
    return res.status(500).json({ message: 'Could not load affiliates' });
  }
};

/**
 * Records a visit to a referral link and returns the attribution token.
 *
 * Called by the public site when it lands on `?ref=CODE`. The token — not the
 * public code — is what the signup form later presents, because a code is visible
 * in every share and could otherwise be replayed by anyone to steal attribution.
 * A click is still recorded against the code so the affiliate's click analytics
 * work even when no signup follows.
 */
exports.attribute = async (req, res) => {
  try {
    const code = String(req.body?.code || req.query?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ message: 'A referral code is required' });

    const affiliate = await User.findOne({
      affiliateCode: code,
      role: 'affiliate',
      'affiliateProfile.status': 'approved',
    }).select('_id affiliateCode');

    // An unknown or inactive code is answered with 204 rather than 404: the public
    // site should not be able to enumerate which codes exist, and a visitor on a
    // stale link should simply browse normally.
    if (!affiliate) return res.status(204).end();

    const token = generateReferralToken();
    await ReferralClick.create({
      code: affiliate.affiliateCode,
      affiliateId: affiliate._id,
      token,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
      referrer: req.headers?.referer,
      landingPath: String(req.body?.path || req.query?.path || '').slice(0, 500),
    });

    return res.status(201).json({ token, code: affiliate.affiliateCode });
  } catch (error) {
    console.error('Referral attribution failed:', error);
    return res.status(500).json({ message: 'Could not record this visit' });
  }
};

// --- affiliate: dashboard and performance ------------------------------------

/**
 * The four summary cards on the affiliate dashboard.
 *
 * Counted from the source collections rather than a cached rollup: the numbers
 * are small (one affiliate's own students), and a stale cache on a money screen
 * is worse than the query cost.
 */
exports.summary = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const scope = studentScope(affiliate._id);
    const today = new Date().toISOString().slice(0, 10);

    const [totalStudents, activeStudents, upcomingAppointments, pendingAgg, availableAgg, totals] =
      await Promise.all([
        User.countDocuments(scope),
        User.countDocuments({
          ...scope,
          'admission.status': { $nin: [...TERMINAL_ADMISSION_STATUSES, 'lead'] },
        }),
        Appointment.countDocuments({
          to: affiliate._id,
          date: { $gte: today },
          status: { $in: ['pending', 'confirmed'] },
        }),
        // Commissions earned but still inside the holding period.
        AffiliateCommission.aggregate([
          { $match: { affiliateId: affiliate._id, status: 'pending' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        // Released and withdrawable.
        AffiliateCommission.aggregate([
          { $match: { affiliateId: affiliate._id, status: 'available' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        AffiliateCommission.aggregate([
          { $match: { affiliateId: affiliate._id, status: { $in: ['available', 'withdrawn', 'pending'] } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      ]);

    return res.json({
      totalStudents,
      activeStudents,
      upcomingAppointments,
      // Naira, like every money field this module returns; the client formats.
      pendingEarnings: toMajor(pendingAgg[0]?.total),
      availableEarnings: toMajor(availableAgg[0]?.total),
      totalEarnings: toMajor(totals[0]?.total),
      balance: Number(affiliate.balance) || 0,
      affiliateId: affiliate.affiliateId || null,
      affiliateCode: affiliate.affiliateCode || null,
      status: affiliate.affiliateProfile?.status || 'pending',
    });
  } catch (error) {
    console.error('Affiliate summary failed:', error);
    return res.status(500).json({ message: 'Could not load your dashboard' });
  }
};

/**
 * Date-filtered performance metrics.
 *
 * `period` accepts today | week | month | year | custom. A custom range with no
 * bounds collapses to all-time rather than erroring, so a half-filled filter
 * still returns something useful.
 */
exports.performance = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const range = periodRange(req.query.period, req.query.from, req.query.to);
    const scope = studentScope(affiliate._id);

    const studentDateFilter = range ? { createdAt: range } : {};
    const commissionDateFilter = range ? { createdAt: range } : {};

    const [newStudents, admissionsByStatus, commissionAgg, clickCount] = await Promise.all([
      User.countDocuments({ ...scope, ...studentDateFilter }),
      // The admissions funnel, so the affiliate can see where their applicants
      // are sitting rather than only how many there are.
      User.aggregate([
        { $match: { ...scope, ...studentDateFilter } },
        { $group: { _id: '$admission.status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AffiliateCommission.aggregate([
        { $match: { affiliateId: affiliate._id, ...commissionDateFilter } },
        {
          $group: {
            _id: '$status',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
      ReferralClick.countDocuments({
        affiliateId: affiliate._id,
        ...(range ? { createdAt: range } : {}),
      }),
    ]);

    const commissions = commissionAgg.reduce(
      (acc, row) => {
        acc[row._id] = { total: toMajor(row.total), count: row.count };
        return acc;
      },
      {}
    );

    return res.json({
      period: req.query.period || 'all',
      newStudents,
      totalClicks: clickCount,
      // Conversion is clicks → signups, which is what an affiliate can actually
      // act on. Guarded against a divide-by-zero when there are no clicks yet.
      conversionRate: clickCount > 0 ? Number(((newStudents / clickCount) * 100).toFixed(1)) : 0,
      admissions: admissionsByStatus.map((row) => ({
        status: row._id || 'lead',
        count: row.count,
      })),
      commissions: {
        pending: commissions.pending || { total: 0, count: 0 },
        available: commissions.available || { total: 0, count: 0 },
        withdrawn: commissions.withdrawn || { total: 0, count: 0 },
        reversed: commissions.reversed || { total: 0, count: 0 },
      },
    });
  } catch (error) {
    console.error('Affiliate performance failed:', error);
    return res.status(500).json({ message: 'Could not load your performance' });
  }
};

// --- affiliate: admissions ---------------------------------------------------

/**
 * The affiliate's student list, with search, status filter and pagination.
 *
 * Scoped by `studentScope`, so an affiliate sees only people they referred or
 * enrolled — never the platform's students at large.
 */
exports.listStudents = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { page, limit, skip } = pagination(req.query);
    const filter = studentScope(affiliate._id);

    const status = String(req.query.status || '').trim();
    if (status && ADMISSION_STATUSES.includes(status)) {
      filter['admission.status'] = status;
    }

    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      // The outer `$or` from studentScope must survive alongside the search `$or`,
      // so the two are combined with $and rather than overwriting one another.
      filter.$and = [
        { $or: filter.$or },
        { $or: [{ fullname: pattern }, { email: pattern }, { phone: pattern }] },
      ];
      delete filter.$or;
    }

    const [rows, total] = await Promise.all([
      User.find(filter)
        .select('fullname email phone assignedCourse admission isVerified blocked createdAt referredByAffiliate registeredBy')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const records = rows.map((row) => ({
      id: row._id,
      fullname: row.fullname,
      email: row.email,
      phone: row.phone,
      course: row.assignedCourse || row.admission?.interestedCourse || null,
      status: row.admission?.status || 'lead',
      // Whether the affiliate enrolled them or the student signed up themselves
      // from the affiliate's link. Useful context when following up.
      origin: String(row.registeredBy) === String(affiliate._id) ? 'enrolled' : 'referred',
      isVerified: row.isVerified === true,
      blocked: row.blocked === true,
      createdAt: row.createdAt,
    }));

    return res.json(paged(records, total, { page, limit }));
  } catch (error) {
    console.error('Affiliate student list failed:', error);
    return res.status(500).json({ message: 'Could not load your students' });
  }
};

/**
 * Adds a prospective student.
 *
 * Creates a real learner account, attributed to this affiliate on both counts: as
 * the referrer (`referredByAffiliate`, which is what earns commission) and as the
 * creator (`registeredBy`, which is what makes them appear in this list). The
 * account starts unverified and with no password the affiliate can see — the
 * student sets their own credentials — so an affiliate cannot sign in as someone
 * they enrolled.
 */
exports.createStudent = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    if (affiliate.affiliateProfile?.status !== 'approved') {
      return res.status(403).json({ message: 'Your affiliate account is not approved yet' });
    }

    const { fullname, email, phone, interestedCourse, intendedStartDate, notes } = req.body || {};

    if (!fullname || !email) {
      return res.status(400).json({ message: 'A name and email address are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    const existing = await User.findOne({ email: normalizedEmail }).select('_id role');
    if (existing) {
      // Distinguish "already your student" from "already on the platform": the
      // first is a no-op the affiliate can ignore, the second is a reason to stop.
      const alreadyMine = await User.exists({ _id: existing._id, ...studentScope(affiliate._id) });
      return res.status(400).json({
        message: alreadyMine
          ? 'This person is already in your student list'
          : 'An account with this email already exists on ExpertHub',
      });
    }

    const student = await User.create({
      username: normalizedEmail,
      email: normalizedEmail,
      fullname: String(fullname).trim(),
      phone: phone || '',
      role: 'student',
      // No password: the account exists as a lead, and the student claims it by
      // signing up or through the verification flow. Creating a default password
      // here would be a shared credential across every affiliate-enrolled student.
      isVerified: false,
      registeredBy: affiliate._id,
      referredByAffiliate: affiliate._id,
      referral: {
        declared: true,
        isReferred: true,
        source: 'affiliate_enrolled',
        affiliateCode: affiliate.affiliateCode || null,
        declaredAt: new Date(),
      },
      admission: {
        status: 'lead',
        interestedCourse: interestedCourse || null,
        intendedStartDate: intendedStartDate || null,
        notes: notes || null,
        updatedAt: new Date(),
        history: [
          {
            status: 'lead',
            at: new Date(),
            by: affiliate._id,
            byRole: 'affiliate',
            note: 'Added by affiliate',
          },
        ],
      },
      ...(interestedCourse ? { assignedCourse: interestedCourse } : {}),
    });

    return res.status(201).json({
      message: 'Student added',
      student: {
        id: student._id,
        fullname: student.fullname,
        email: student.email,
        status: 'lead',
      },
    });
  } catch (error) {
    console.error('Affiliate create student failed:', error);
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'An account with this email already exists' });
    }
    return res.status(500).json({ message: 'Could not add this student' });
  }
};

/** One student, with their admissions history and the commission they generated. */
exports.getStudent = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    // Scoped: a student the affiliate did not refer or enrol resolves to null,
    // so its existence is not disclosed either.
    const student = await User.findOne({ _id: req.params.id, ...studentScope(affiliate._id) })
      .select('fullname email phone country state assignedCourse admission isVerified blocked createdAt')
      .lean();

    if (!student) return res.status(404).json({ message: 'Student not found' });

    const commissions = await AffiliateCommission.find({
      affiliateId: affiliate._id,
      studentId: student._id,
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({
      student: {
        id: student._id,
        fullname: student.fullname,
        email: student.email,
        phone: student.phone,
        country: student.country,
        state: student.state,
        course: student.assignedCourse || student.admission?.interestedCourse || null,
        status: student.admission?.status || 'lead',
        notes: student.admission?.notes || null,
        intendedStartDate: student.admission?.intendedStartDate || null,
        isVerified: student.isVerified === true,
        blocked: student.blocked === true,
        createdAt: student.createdAt,
      },
      history: (student.admission?.history || []).slice().reverse(),
      commissions: commissions.map((row) => ({
        ref: row.commissionRef,
        amount: toMajor(row.amount),
        status: row.status,
        createdAt: row.createdAt,
      })),
    });
  } catch (error) {
    console.error('Affiliate student detail failed:', error);
    return res.status(500).json({ message: 'Could not load this student' });
  }
};

/**
 * Advances a student's admissions status.
 *
 * Appends to the history rather than overwriting, so the journey stays
 * reconstructable. Enrolment and payment statuses (`registered` onward) are
 * deliberately *not* settable here — those are earned by the system when a
 * payment settles, and letting an affiliate assert them by hand would let them
 * manufacture a commission.
 */
exports.updateStudent = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    const AFFILIATE_SETTABLE = [
      'lead',
      'application_started',
      'application_submitted',
      'under_review',
      'withdrawn',
      'cancelled',
    ];

    const { status, notes, interestedCourse, intendedStartDate } = req.body || {};

    const update = {};
    if (typeof notes === 'string') update['admission.notes'] = notes.slice(0, 2000);
    if (typeof interestedCourse === 'string') update['admission.interestedCourse'] = interestedCourse.slice(0, 200);
    if (typeof intendedStartDate === 'string') update['admission.intendedStartDate'] = intendedStartDate.slice(0, 40);
    update['admission.updatedAt'] = new Date();

    if (status !== undefined) {
      if (!ADMISSION_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Unknown admission status' });
      }
      if (!AFFILIATE_SETTABLE.includes(status)) {
        return res.status(403).json({
          message: 'This status is set by the system, not by an affiliate',
        });
      }
      update['admission.status'] = status;
    }

    const student = await User.findOne({ _id: req.params.id, ...studentScope(affiliate._id) }).select(
      'admission fullname'
    );
    if (!student) return res.status(404).json({ message: 'Student not found' });

    const previousStatus = student.admission?.status || 'lead';
    const historyEntry = {
      status: update['admission.status'] || previousStatus,
      at: new Date(),
      by: affiliate._id,
      byRole: 'affiliate',
      note: typeof notes === 'string' ? notes.slice(0, 500) : undefined,
    };

    await User.updateOne(
      { _id: student._id },
      { $set: update, $push: { 'admission.history': historyEntry } }
    );

    return res.json({ message: 'Student updated', status: update['admission.status'] || previousStatus });
  } catch (error) {
    console.error('Affiliate student update failed:', error);
    return res.status(500).json({ message: 'Could not update this student' });
  }
};

// --- affiliate: referral -----------------------------------------------------

/**
 * The affiliate's referral link and its performance.
 *
 * The link is only issued to an approved affiliate. Before approval the code is
 * withheld, because a link that cannot earn is worse than no link — the affiliate
 * would share it, generate clicks, and earn nothing.
 */
exports.referral = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const status = affiliate.affiliateProfile?.status || 'pending';
    const baseUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');

    const [clicks, conversions, referredCount] = await Promise.all([
      ReferralClick.countDocuments({ affiliateId: affiliate._id }),
      ReferralClick.countDocuments({ affiliateId: affiliate._id, convertedUserId: { $exists: true } }),
      User.countDocuments(studentScope(affiliate._id)),
    ]);

    return res.json({
      status,
      affiliateId: affiliate.affiliateId || null,
      affiliateCode: affiliate.affiliateCode || null,
      // Shape per the spec: ExpertHub Website / register / Affiliate-Code. Only
      // built once a code exists, so the client never renders a broken link.
      link: affiliate.affiliateCode ? `${baseUrl}/auth/signup?role=student&ref=${affiliate.affiliateCode}` : null,
      stats: { clicks, conversions, referredStudents: referredCount },
    });
  } catch (error) {
    console.error('Affiliate referral failed:', error);
    return res.status(500).json({ message: 'Could not load your referral link' });
  }
};

// --- affiliate: wallet -------------------------------------------------------

/**
 * Wallet overview.
 *
 * Reuses the platform wallet — the same `User.balance` and `Transaction` ledger
 * every other role uses — and adds the affiliate-specific breakdown of what is
 * still in its holding period versus what is withdrawable. Duplicating a second
 * balance would be the single most expensive kind of duplication here.
 */
exports.wallet = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const [pendingAgg, availableAgg, lifetimeAgg, withdrawnAgg] = await Promise.all([
      AffiliateCommission.aggregate([
        { $match: { affiliateId: affiliate._id, status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      AffiliateCommission.aggregate([
        { $match: { affiliateId: affiliate._id, status: 'available' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      AffiliateCommission.aggregate([
        { $match: { affiliateId: affiliate._id, status: { $in: ['pending', 'available', 'withdrawn'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            userId: affiliate._id,
            type: 'debit',
            direction: 'debit',
            status: { $in: ['pending', 'successful'] },
            'metadata.purpose': 'withdrawal',
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    // The next moment anything becomes withdrawable, so the UI can say "next
    // release" instead of leaving the affiliate guessing.
    const nextRelease = await AffiliateCommission.findOne({
      affiliateId: affiliate._id,
      status: 'pending',
    })
      .sort({ holdUntil: 1 })
      .select('holdUntil amount')
      .lean();

    return res.json({
      // Naira throughout.
      balance: Number(affiliate.balance) || 0,
      pendingEarnings: toMajor(pendingAgg[0]?.total),
      availableEarnings: toMajor(availableAgg[0]?.total),
      lifetimeEarnings: toMajor(lifetimeAgg[0]?.total),
      totalWithdrawn: Number(withdrawnAgg[0]?.total) || 0,
      nextReleaseAt: nextRelease?.holdUntil || null,
      nextReleaseAmount: toMajor(nextRelease?.amount),
      bank: {
        bankName: affiliate.bankName || null,
        bankCode: affiliate.bankCode || null,
        accountName: affiliate.accountName || null,
        accountNumber: maskAccountNumber(affiliate.accountNumber),
        hasPayoutAccount: Boolean(affiliate.bankCode && affiliate.accountNumber),
      },
    });
  } catch (error) {
    console.error('Affiliate wallet failed:', error);
    return res.status(500).json({ message: 'Could not load your wallet' });
  }
};

/** The affiliate's wallet ledger, filterable and paginated. */
exports.listTransactions = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { page, limit, skip } = pagination(req.query);

    // Scoped to the caller's own id — the ledger is never queried by a
    // client-supplied user id.
    const filter = { userId: affiliate._id };

    const type = String(req.query.type || '').trim();
    if (type) filter.type = type;

    const status = String(req.query.status || '').trim();
    if (status) filter.status = status;

    const range = periodRange(req.query.period, req.query.from, req.query.to);
    if (range) filter.date = range;

    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ txRef: pattern }, { reference: pattern }, { type: pattern }];
    }

    const [rows, total] = await Promise.all([
      Transaction.find(filter).sort({ date: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(filter),
    ]);

    const records = rows.map((row) => ({
      id: row._id,
      amount: row.amount,
      type: row.type,
      direction: row.direction || null,
      status: row.status,
      balanceAfter: row.balanceAfter ?? null,
      reference: row.reference || row.txRef || null,
      date: row.date || row.paidAt || row.createdAt,
    }));

    return res.json(paged(records, total, { page, limit }));
  } catch (error) {
    console.error('Affiliate transactions failed:', error);
    return res.status(500).json({ message: 'Could not load your transactions' });
  }
};

/** The affiliate's commission rows, including those still inside the hold. */
exports.listCommissions = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { page, limit, skip } = pagination(req.query);

    const filter = { affiliateId: affiliate._id };
    const status = String(req.query.status || '').trim();
    if (status) filter.status = status;

    const [rows, total] = await Promise.all([
      AffiliateCommission.find(filter)
        .populate('studentId', 'fullname email')
        .populate('courseId', 'title')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AffiliateCommission.countDocuments(filter),
    ]);

    const records = rows.map((row) => ({
      ref: row.commissionRef,
      amount: toMajor(row.amount),
      status: row.status,
      rateType: row.rateType,
      rateValue: row.rateValue,
      baseAmount: toMajor(row.baseAmount),
      student: row.studentId ? { fullname: row.studentId.fullname, email: row.studentId.email } : null,
      course: row.courseId?.title || null,
      holdUntil: row.holdUntil,
      releasedAt: row.releasedAt,
      reversalReason: row.reversalReason || null,
      createdAt: row.createdAt,
    }));

    return res.json(paged(records, total, { page, limit }));
  } catch (error) {
    console.error('Affiliate commissions failed:', error);
    return res.status(500).json({ message: 'Could not load your commissions' });
  }
};

/**
 * Requests a withdrawal.
 *
 * Delegates to the platform's `executeWithdrawal`, so an affiliate payout takes
 * exactly the same hold-then-transfer path, with the same duplicate protection
 * and refund sweep, as every other role's. The HTTP status mapping is copied from
 * the wallet controller so the client sees identical semantics.
 */
exports.withdraw = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Please enter a valid amount' });
    }
    if (amount < 500) {
      return res.status(400).json({ message: 'The minimum withdrawal is ₦500' });
    }
    if (amount > 5000000) {
      return res.status(400).json({ message: 'The maximum withdrawal is ₦5,000,000' });
    }

    // Round to kobo so a float artefact cannot debit a fraction of a kobo that
    // never reconciles against the ledger.
    const rounded = Math.round(amount * 100) / 100;

    const result = await executeWithdrawal({ user: affiliate, amount: rounded, source: 'affiliate' });

    if (result.outcome === 'no_account' || result.outcome === 'insufficient' || result.outcome === 'refunded') {
      return res.status(400).json({ message: result.message, reason: result.reason || null });
    }
    if (result.outcome === 'in_progress') {
      return res.status(409).json({ message: result.message });
    }
    if (result.outcome === 'successful') {
      logAudit({
        req,
        action: 'withdrawal.completed',
        entity: 'User',
        entityId: affiliate._id,
        after: { amount: rounded, transactionId: String(result.transactionId) },
      });
      return res.status(200).json({ message: result.message, transactionId: result.transactionId });
    }

    // Queued at the gateway; the webhook or the reconciliation sweep settles it.
    logAudit({
      req,
      action: 'withdrawal.requested',
      entity: 'User',
      entityId: affiliate._id,
      after: { amount: rounded, transactionId: String(result.transactionId) },
    });
    return res.status(202).json({ message: result.message, transactionId: result.transactionId });
  } catch (error) {
    console.error('Affiliate withdrawal failed:', error.response?.data || error.message);
    return res.status(500).json({ message: 'Withdrawal failed. Please try again.' });
  }
};

// --- affiliate: calendar -----------------------------------------------------

/** Appointments addressed to this affiliate, optionally filtered by range. */
exports.listAppointments = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { page, limit, skip } = pagination(req.query, { defaultLimit: 100, maxLimit: 200 });

    // `to` is the affiliate: appointments are booked *with* them.
    const filter = { to: affiliate._id };

    const status = String(req.query.status || '').trim();
    if (status) filter.status = status;

    // `date` is a plain YYYY-MM-DD string, so a lexicographic range works and
    // needs no date parsing — which is exactly why it is stored that way.
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = String(req.query.from).slice(0, 10);
      if (req.query.to) filter.date.$lte = String(req.query.to).slice(0, 10);
    }

    const [rows, total] = await Promise.all([
      Appointment.find(filter)
        .populate('from', 'fullname email profilePicture')
        .sort({ date: 1, startTime: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Appointment.countDocuments(filter),
    ]);

    const records = rows.map((row) => ({
      id: row._id,
      title: row.title || row.category || 'Appointment',
      category: row.category,
      reason: row.reason,
      mode: row.mode,
      status: row.status || 'pending',
      date: row.date,
      time: row.time,
      startTime: row.startTime,
      endTime: row.endTime,
      meetingType: row.meetingType,
      meetingLink: row.meetingLink,
      location: row.location,
      notes: row.notes,
      attendee: row.from
        ? { id: row.from._id, fullname: row.from.fullname, email: row.from.email, profilePicture: row.from.profilePicture }
        : null,
    }));

    return res.json(paged(records, total, { page, limit }));
  } catch (error) {
    console.error('Affiliate appointments failed:', error);
    return res.status(500).json({ message: 'Could not load your calendar' });
  }
};

/** Books an appointment for this affiliate. */
exports.createAppointment = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { title, category, reason, mode, date, time, startTime, endTime, meetingType, meetingLink, location, notes, attendeeId } =
      req.body || {};

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ message: 'Please choose a valid date' });
    }
    if (!category && !title) {
      return res.status(400).json({ message: 'Please give this appointment a title or category' });
    }

    // A named attendee must be one of this affiliate's own students; otherwise an
    // appointment could be attached to any account on the platform.
    let from = affiliate._id;
    if (attendeeId) {
      if (!isObjectId(attendeeId)) return res.status(400).json({ message: 'Invalid attendee' });
      const attendee = await User.findOne({ _id: attendeeId, ...studentScope(affiliate._id) }).select('_id');
      if (!attendee) return res.status(404).json({ message: 'That student is not in your list' });
      from = attendee._id;
    }

    const appointment = await Appointment.create({
      from,
      to: affiliate._id,
      mode: mode || 'virtual',
      category: category || title,
      title: title || category,
      reason,
      status: 'pending',
      date: String(date).slice(0, 10),
      time: time || startTime || null,
      startTime: startTime || null,
      endTime: endTime || null,
      meetingType: meetingType || (mode === 'physical' ? 'physical' : 'virtual'),
      meetingLink: meetingLink || null,
      location: location || null,
      notes: notes ? String(notes).slice(0, 2000) : null,
    });

    return res.status(201).json({ message: 'Appointment created', id: appointment._id });
  } catch (error) {
    console.error('Affiliate create appointment failed:', error);
    return res.status(500).json({ message: 'Could not create this appointment' });
  }
};

/** Reschedules or re-statuses an appointment the affiliate owns. */
exports.updateAppointment = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    if (!isObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid appointment id' });

    const { status, date, startTime, endTime, time, notes, cancellationReason, meetingLink } = req.body || {};

    const ALLOWED = ['pending', 'confirmed', 'completed', 'cancelled', 'rescheduled', 'no_show'];

    const update = {};
    if (status !== undefined) {
      if (!ALLOWED.includes(status)) return res.status(400).json({ message: 'Unknown appointment status' });
      update.status = status;
    }
    if (date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return res.status(400).json({ message: 'Please choose a valid date' });
      }
      update.date = String(date).slice(0, 10);
    }
    if (time !== undefined) update.time = time;
    if (startTime !== undefined) update.startTime = startTime;
    if (endTime !== undefined) update.endTime = endTime;
    if (notes !== undefined) update.notes = String(notes).slice(0, 2000);
    if (meetingLink !== undefined) update.meetingLink = meetingLink;
    if (cancellationReason !== undefined) update.cancellationReason = String(cancellationReason).slice(0, 500);

    if (!Object.keys(update).length) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    // Scoped by `to`: an affiliate may only change appointments addressed to them.
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, to: affiliate._id },
      { $set: update },
      { new: true }
    );
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

    return res.json({ message: 'Appointment updated', status: appointment.status });
  } catch (error) {
    console.error('Affiliate update appointment failed:', error);
    return res.status(500).json({ message: 'Could not update this appointment' });
  }
};

/** Cancels an appointment. A soft cancel, so the record survives for the calendar. */
exports.deleteAppointment = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    if (!isObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid appointment id' });

    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, to: affiliate._id },
      { $set: { status: 'cancelled', cancellationReason: String(req.body?.reason || 'Cancelled by affiliate').slice(0, 500) } },
      { new: true }
    );
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

    return res.json({ message: 'Appointment cancelled' });
  } catch (error) {
    console.error('Affiliate delete appointment failed:', error);
    return res.status(500).json({ message: 'Could not cancel this appointment' });
  }
};

// --- affiliate: profile and notifications ------------------------------------

exports.getProfile = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    return res.json({
      profile: {
        id: affiliate._id,
        fullname: affiliate.fullname,
        email: affiliate.email,
        phone: affiliate.phone,
        country: affiliate.country,
        state: affiliate.state,
        address: affiliate.address,
        profilePicture: affiliate.image || affiliate.profilePicture || null,
        affiliateId: affiliate.affiliateId || null,
        affiliateCode: affiliate.affiliateCode || null,
        status: affiliate.affiliateProfile?.status || 'pending',
        application: {
          type: affiliate.affiliateProfile?.type || 'individual',
          businessName: affiliate.affiliateProfile?.businessName || null,
          website: affiliate.affiliateProfile?.website || null,
          socialLinks: affiliate.affiliateProfile?.socialLinks || {},
          submittedAt: affiliate.affiliateProfile?.submittedAt || null,
          approvedAt: affiliate.affiliateProfile?.approvedAt || null,
          rejectionReason: affiliate.affiliateProfile?.rejectionReason || null,
          suspensionReason: affiliate.affiliateProfile?.suspensionReason || null,
          reviewNote: affiliate.affiliateProfile?.reviewNote || null,
        },
        bank: {
          bankName: affiliate.bankName || null,
          bankCode: affiliate.bankCode || null,
          accountName: affiliate.accountName || null,
          accountNumber: maskAccountNumber(affiliate.accountNumber),
          hasPayoutAccount: Boolean(affiliate.bankCode && affiliate.accountNumber),
        },
      },
    });
  } catch (error) {
    console.error('Affiliate profile failed:', error);
    return res.status(500).json({ message: 'Could not load your profile' });
  }
};

/**
 * Updates the affiliate's own profile.
 *
 * Only fields the affiliate legitimately owns are writable here. Status, the
 * affiliate id and the code are all admin-issued and deliberately absent — an
 * affiliate must not be able to approve themselves or mint their own code.
 */
exports.updateProfile = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { fullname, phone, country, state, address, businessName, website, socialLinks, payoutPreference } =
      req.body || {};

    const update = {};
    let invalidSocial = false;
    if (typeof fullname === 'string' && fullname.trim()) update.fullname = fullname.trim().slice(0, 120);
    if (typeof phone === 'string') update.phone = phone.slice(0, 40);
    if (typeof country === 'string') update.country = country.slice(0, 80);
    if (typeof state === 'string') update.state = state.slice(0, 80);
    if (typeof address === 'string') update.address = address.slice(0, 300);

    if (typeof businessName === 'string') update['affiliateProfile.businessName'] = businessName.slice(0, 160);

    // Normalised, not stored verbatim. These fields become links wherever the
    // application is displayed, and `javascript:` is a valid thing to type into a
    // Website box — a value that will not parse as http(s) is dropped rather than
    // persisted for some future renderer to trust.
    if (website !== undefined) {
      const normalized = normalizeUrl(website);
      if (normalized) update['affiliateProfile.website'] = normalized;
      else if (String(website).trim()) {
        return res.status(400).json({ message: 'Please enter a valid website address' });
      } else {
        // An emptied field is a deliberate clear, so it is stored as such.
        update['affiliateProfile.website'] = '';
      }
    }

    if (typeof payoutPreference === 'string') update['affiliateProfile.payoutPreference'] = payoutPreference.slice(0, 40);

    if (socialLinks && typeof socialLinks === 'object') {
      // Whitelisted keys only: spreading the body straight in would let a caller
      // write arbitrary paths into the document.
      SOCIAL_KEYS.forEach((key) => {
        if (typeof socialLinks[key] !== 'string') return;
        const normalized = normalizeUrl(socialLinks[key]);
        // A cleared field stays cleared; an unparseable one is refused outright
        // so the affiliate is told, rather than silently losing the link.
        if (normalized) {
          update[`affiliateProfile.socialLinks.${key}`] = normalized;
        } else if (socialLinks[key].trim()) {
          invalidSocial = true;
        } else {
          update[`affiliateProfile.socialLinks.${key}`] = '';
        }
      });
    }

    if (invalidSocial) {
      return res.status(400).json({ message: 'One of your social links is not a valid address' });
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    await User.updateOne({ _id: affiliate._id }, { $set: update });

    return res.json({ message: 'Profile updated' });
  } catch (error) {
    console.error('Affiliate profile update failed:', error);
    return res.status(500).json({ message: 'Could not update your profile' });
  }
};

/**
 * Saves the affiliate's payout bank account.
 *
 * The account number is stored in full — the gateway needs it to pay out — but is
 * only ever *returned* masked. A rejected account number is not persisted, so a
 * typo cannot leave the wallet pointing at an account the bank never confirmed.
 */
exports.updateBankDetails = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { bankCode, bankName, accountNumber, accountName } = req.body || {};

    if (!bankCode || !accountNumber) {
      return res.status(400).json({ message: 'A bank and account number are required' });
    }
    const digits = String(accountNumber).replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 10) {
      return res.status(400).json({ message: 'A Nigerian account number is 10 digits' });
    }

    await User.updateOne(
      { _id: affiliate._id },
      {
        $set: {
          bankCode: String(bankCode).slice(0, 20),
          bankName: bankName ? String(bankName).slice(0, 120) : affiliate.bankName,
          accountNumber: digits,
          accountName: accountName ? String(accountName).slice(0, 160) : affiliate.accountName,
        },
      }
    );

    return res.json({
      message: 'Bank details saved',
      bank: { bankName: bankName || affiliate.bankName, accountName: accountName || affiliate.accountName, accountNumber: maskAccountNumber(digits) },
    });
  } catch (error) {
    console.error('Affiliate bank details failed:', error);
    return res.status(500).json({ message: 'Could not save your bank details' });
  }
};

exports.listNotifications = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    const { page, limit, skip } = pagination(req.query, { defaultLimit: 30, maxLimit: 100 });

    // Scoped to the caller: notifications are never fetched by a client-supplied
    // user id.
    const filter = { userId: affiliate._id };
    if (String(req.query.unreadOnly || '') === 'true') filter.read = { $ne: true };

    const [rows, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ userId: affiliate._id, read: { $ne: true } }),
    ]);

    return res.json({
      ...paged(
        rows.map((row) => ({
          id: row._id,
          title: row.title,
          content: row.content,
          contentId: row.contentId,
          read: row.read === true,
          createdAt: row.createdAt,
        })),
        total,
        { page, limit }
      ),
      unread,
    });
  } catch (error) {
    console.error('Affiliate notifications failed:', error);
    return res.status(500).json({ message: 'Could not load your notifications' });
  }
};

exports.markNotificationsRead = async (req, res) => {
  try {
    const affiliate = await requireAffiliate(req, res);
    if (!affiliate) return;

    // Scoped by userId in the filter, so one affiliate cannot mark another's
    // notifications read even by passing their ids.
    const filter = { userId: affiliate._id };
    if (req.body?.ids && Array.isArray(req.body.ids) && req.body.ids.length) {
      filter._id = { $in: req.body.ids.filter(isObjectId) };
    }

    const result = await Notification.updateMany(filter, { $set: { read: true } });
    return res.json({ message: 'Notifications updated', updated: result.modifiedCount || 0 });
  } catch (error) {
    console.error('Affiliate notifications update failed:', error);
    return res.status(500).json({ message: 'Could not update your notifications' });
  }
};

// --- provider: commission settings (requirement 2) ---------------------------

/**
 * Reads the caller's affiliate commission settings.
 *
 * This is the training provider's control over what affiliates earn on *their*
 * courses. It lives on the provider's own account, so it is read and written with
 * `req.user.id` and never takes a provider id from the request.
 */
exports.getSettings = async (req, res) => {
  try {
    const provider = await User.findById(req.user.id).select('affiliateSettings organizationName fullname');
    if (!provider) return res.status(404).json({ message: 'Account not found' });

    const settings = provider.affiliateSettings || {};

    return res.json({
      settings: {
        enabled: settings.enabled !== false,
        defaultCommissionType: settings.defaultCommissionType || 'percentage',
        defaultCommissionRate: Number(settings.defaultCommissionRate) || 0,
        maxCommissionCap: Number(settings.maxCommissionCap) || 0,
        // Null means "use the platform default", which the client shows as such
        // rather than pretending the provider chose a number.
        holdDays: settings.holdDays === null || settings.holdDays === undefined ? null : Number(settings.holdDays),
        affiliateOverrides: (settings.affiliateOverrides || []).map((entry) => ({
          affiliateId: entry.affiliateId,
          type: entry.type,
          value: entry.value,
        })),
        updatedAt: settings.updatedAt || null,
      },
      limits: { maxCommissionRate: MAX_COMMISSION_RATE },
    });
  } catch (error) {
    console.error('Affiliate settings read failed:', error);
    return res.status(500).json({ message: 'Could not load your affiliate settings' });
  }
};

/**
 * Saves the provider's affiliate commission settings.
 *
 * Every bound is validated with a specific message, because a silently clamped
 * commission rate is a rate the provider believes they set and did not. An
 * out-of-range value is refused outright rather than adjusted.
 */
exports.updateSettings = async (req, res) => {
  try {
    const provider = await User.findById(req.user.id).select('affiliateSettings role');
    if (!provider) return res.status(404).json({ message: 'Account not found' });

    const { enabled, defaultCommissionType, defaultCommissionRate, maxCommissionCap, holdDays, affiliateOverrides } =
      req.body || {};

    const update = { 'affiliateSettings.updatedAt': new Date() };
    const before = provider.affiliateSettings ? provider.affiliateSettings.toObject?.() || provider.affiliateSettings : {};

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') return res.status(400).json({ message: 'Enabled must be true or false' });
      update['affiliateSettings.enabled'] = enabled;
    }

    if (defaultCommissionType !== undefined) {
      if (!['percentage', 'fixed'].includes(defaultCommissionType)) {
        return res.status(400).json({ message: 'Commission type must be percentage or fixed' });
      }
      update['affiliateSettings.defaultCommissionType'] = defaultCommissionType;
    }

    if (defaultCommissionRate !== undefined) {
      const rate = Number(defaultCommissionRate);
      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(400).json({ message: 'Commission rate must be a number of 0 or more' });
      }
      const type = defaultCommissionType || provider.affiliateSettings?.defaultCommissionType || 'percentage';
      if (type === 'percentage' && rate > MAX_COMMISSION_RATE) {
        return res.status(400).json({
          message: `The commission rate cannot exceed ${MAX_COMMISSION_RATE}%`,
        });
      }
      update['affiliateSettings.defaultCommissionRate'] = rate;
    }

    if (maxCommissionCap !== undefined) {
      const cap = Number(maxCommissionCap);
      if (!Number.isFinite(cap) || cap < 0) {
        return res.status(400).json({ message: 'The commission cap must be a number of 0 or more' });
      }
      // 0 is the documented "no cap" value, so it is allowed through.
      update['affiliateSettings.maxCommissionCap'] = cap;
    }

    if (holdDays !== undefined) {
      // Explicit null clears the override and falls back to the platform default.
      if (holdDays === null) {
        update['affiliateSettings.holdDays'] = null;
      } else {
        const days = Number(holdDays);
        if (!Number.isInteger(days) || days < 0 || days > 90) {
          return res.status(400).json({ message: 'The holding period must be a whole number of days between 0 and 90' });
        }
        update['affiliateSettings.holdDays'] = days;
      }
    }

    if (affiliateOverrides !== undefined) {
      if (!Array.isArray(affiliateOverrides)) {
        return res.status(400).json({ message: 'Affiliate overrides must be a list' });
      }
      const cleaned = [];
      for (const entry of affiliateOverrides) {
        if (!entry || !isObjectId(entry.affiliateId)) {
          return res.status(400).json({ message: 'Each override needs a valid affiliate' });
        }
        const type = entry.type === 'fixed' ? 'fixed' : 'percentage';
        const value = Number(entry.value);
        if (!Number.isFinite(value) || value < 0) {
          return res.status(400).json({ message: 'Each override needs a rate of 0 or more' });
        }
        if (type === 'percentage' && value > MAX_COMMISSION_RATE) {
          return res.status(400).json({ message: `An override cannot exceed ${MAX_COMMISSION_RATE}%` });
        }
        cleaned.push({ affiliateId: entry.affiliateId, type, value });
      }
      update['affiliateSettings.affiliateOverrides'] = cleaned;
    }

    await User.updateOne({ _id: provider._id }, { $set: update });

    logAudit({
      req,
      action: 'commission_settings.updated',
      entity: 'User',
      entityId: provider._id,
      before,
      after: update,
    });

    return res.json({ message: 'Affiliate settings saved' });
  } catch (error) {
    console.error('Affiliate settings update failed:', error);
    return res.status(500).json({ message: 'Could not save your affiliate settings' });
  }
};

// --- provider: an affiliate's earnings on my courses --------------------------

/**
 * What affiliates have earned on this provider's own courses.
 *
 * Scoped by course ownership, mirroring how the payment-records screen scopes
 * rows to the tutor who owns the course — a provider sees commission on their
 * courses and nothing else.
 */
exports.listCourseCommissions = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);

    const ownedCourseIds = await Course.find({ instructorId: req.user.id }).distinct('_id');
    if (!ownedCourseIds.length) {
      return res.json(paged([], 0, { page, limit }));
    }

    const filter = { courseId: { $in: ownedCourseIds } };
    const status = String(req.query.status || '').trim();
    if (status) filter.status = status;

    const [rows, total] = await Promise.all([
      AffiliateCommission.find(filter)
        .populate('affiliateId', 'fullname affiliateId')
        .populate('studentId', 'fullname email')
        .populate('courseId', 'title')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AffiliateCommission.countDocuments(filter),
    ]);

    return res.json(
      paged(
        rows.map((row) => ({
          ref: row.commissionRef,
          amount: toMajor(row.amount),
          status: row.status,
          rateType: row.rateType,
          rateValue: row.rateValue,
          baseAmount: toMajor(row.baseAmount),
          affiliate: row.affiliateId
            ? { id: row.affiliateId._id, fullname: row.affiliateId.fullname, affiliateId: row.affiliateId.affiliateId }
            : null,
          student: row.studentId ? { fullname: row.studentId.fullname, email: row.studentId.email } : null,
          course: row.courseId?.title || null,
          createdAt: row.createdAt,
        })),
        total,
        { page, limit }
      )
    );
  } catch (error) {
    console.error('Course commissions failed:', error);
    return res.status(500).json({ message: 'Could not load commissions' });
  }
};

module.exports.TUTOR_ONLY_ROLES = TUTOR_ONLY;
module.exports.ADMISSION_STATUSES = ADMISSION_STATUSES;
module.exports.TERMINAL_ADMISSION_STATUSES = TERMINAL_ADMISSION_STATUSES;
module.exports.maskAccountNumber = maskAccountNumber;
module.exports.escapeRegex = escapeRegex;
module.exports.studentScope = studentScope;
module.exports.toMajor = toMajor;
