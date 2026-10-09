const mongoose = require('mongoose');
const TutorEarning = require('../models/tutorEarning');
const { scopeIdOf } = require('../utils/actingOwner.js');

/**
 * The tutor earning ledger, as a table.
 *
 * One row per earning event — one settled payment to one tutor — which is the
 * same shape the admin affiliate commission ledger uses, and for the same reason:
 * an aggregate per tutor answers "who earned most" but cannot answer "what did
 * this one row of ₦40,000 come from, and is it still in holding?", which is what
 * a provider querying a payout actually needs.
 *
 * Two audiences, one rule. An admin sees the whole platform; everybody else sees
 * the rows on the courses they own. The scope is the only thing that differs, so
 * it is decided once in `scopeFilter` rather than restated per handler.
 */

const MINOR_UNIT = 100;
const toMajor = (minor) => Number((Number(minor || 0) / MINOR_UNIT).toFixed(2));

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

/** Escapes a user-supplied string before it reaches a RegExp. */
function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which rows this caller may see.
 *
 * An admin scopes the whole platform, so the filter is empty — which is the
 * product rule, not an oversight: the admin console's My Instructors screen is
 * the platform-wide one, and the provider's is the same screen narrowed to their
 * own catalogue. `resolveForOwner` already ignores the acting header for admins,
 * so this is the only place the distinction needs expressing.
 *
 * For everyone else the scope is the courses they own, read through
 * `scopeIdOf(req)` so a delegated team member sees the account they are working
 * in rather than their own — which would be empty, since an affiliate member owns
 * no courses.
 *
 * Both spellings of the id travel in the `$in`: `providerId` is an ObjectId this
 * backend writes itself, but the summary runs as an aggregate, whose `$match`
 * Mongoose never casts, so a string-stored id would otherwise be missed and the
 * totals would read low — the direction that looks like a quiet month.
 */
function scopeFilter(req) {
  if (req.user?.role === 'admin') return {};

  const scope = String(scopeIdOf(req));
  const spellings = [scope];
  if (isObjectId(scope)) spellings.push(new mongoose.Types.ObjectId(scope));
  return { providerId: { $in: spellings } };
}

/** How the ledger's own status reads to the person looking at it. */
const STATUS_FILTERS = ['pending', 'available', 'withdrawn', 'reversed'];

function rowFor(row, { includeProvider }) {
  return {
    ref: row.earningRef,
    tutor: row.tutorId
      ? { id: row.tutorId._id, fullname: row.tutorId.fullname }
      : null,
    course: row.courseId?.title || null,
    student: row.studentId
      ? { fullname: row.studentId.fullname, email: row.studentId.email }
      : null,
    studentFee: toMajor(row.baseAmount),
    amount: toMajor(row.amount),
    rateType: row.rateType,
    rateValue: row.rateValue,
    rateSource: row.rateSource || null,
    status: row.status,
    holdUntil: row.holdUntil,
    releasedAt: row.releasedAt || null,
    reversalReason: row.reversalReason || null,
    // Only the admin view varies by provider, so it is the only view that is told
    // which one a row belongs to.
    ...(includeProvider
      ? { provider: row.providerId ? { id: row.providerId._id, fullname: row.providerId.fullname } : null }
      : {}),
    createdAt: row.createdAt,
  };
}

/**
 * The My Instructors table.
 *
 * Mounted twice — once for a provider, once for an admin — because the guards
 * differ (a provider's route admits team members with the payments grant, an
 * admin's admits only admins) even though the rule below does not.
 */
exports.listInstructors = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const filter = scopeFilter(req);

    const status = String(req.query.status || '').trim();
    if (STATUS_FILTERS.includes(status)) filter.status = status;

    if (isObjectId(req.query.courseId)) filter.courseId = req.query.courseId;
    if (isObjectId(req.query.tutorId)) filter.tutorId = req.query.tutorId;

    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ earningRef: pattern }, { sourceTransaction: pattern }];
    }

    const [rows, total] = await Promise.all([
      TutorEarning.find(filter)
        .populate('tutorId', 'fullname')
        .populate('studentId', 'fullname email')
        .populate('courseId', 'title')
        .populate('providerId', 'fullname')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      TutorEarning.countDocuments(filter),
    ]);

    const includeProvider = req.user?.role === 'admin';

    return res.json(paged(rows.map((row) => rowFor(row, { includeProvider })), total, { page, limit }));
  } catch (error) {
    console.error('Tutor earning list failed:', error);
    return res.status(500).json({ message: 'Could not load instructor earnings' });
  }
};

/**
 * The figures above the table.
 *
 * Deliberately a different reduction from the list: this answers "how much have
 * my tutors earned altogether, and how much is still in holding?", which a page
 * of rows cannot without the client summing it and getting reversals wrong.
 *
 * Reversals are handled by arithmetic rather than by exclusion. `amount` is signed
 * — a reversal row is the same amount negated — so summing it is the true net paid
 * to tutors with no special case. `studentFees` needs the opposite treatment,
 * because a reversal row copies its original's `baseAmount` unchanged and summing
 * those would count one course fee twice.
 */
exports.summary = async (req, res) => {
  try {
    const filter = scopeFilter(req);

    const [totals, tutorIds] = await Promise.all([
      TutorEarning.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            commission: { $sum: '$amount' },
            inHolding: {
              $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] },
            },
            available: {
              $sum: { $cond: [{ $eq: ['$status', 'available'] }, '$amount', 0] },
            },
            withdrawn: {
              $sum: { $cond: [{ $eq: ['$status', 'withdrawn'] }, '$amount', 0] },
            },
            studentFees: {
              // A positive row that is not a reversal still stands: the fee it was
              // computed on was really paid.
              $sum: {
                $cond: [
                  { $and: [{ $gt: ['$amount', 0] }, { $ne: ['$status', 'reversed'] }] },
                  '$baseAmount',
                  0,
                ],
              },
            },
          },
        },
      ]),
      TutorEarning.distinct('tutorId', filter),
    ]);

    const result = totals[0] || {};

    return res.json({
      summary: {
        instructors: tutorIds.length,
        studentFees: toMajor(result.studentFees),
        commission: toMajor(result.commission),
        inHolding: toMajor(result.inHolding),
        available: toMajor(result.available),
        withdrawn: toMajor(result.withdrawn),
      },
    });
  } catch (error) {
    console.error('Tutor earning summary failed:', error);
    return res.status(500).json({ message: 'Could not load the instructor summary' });
  }
};
