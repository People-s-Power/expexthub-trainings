const mongoose = require('mongoose');
const User = require('../models/user');
const Course = require('../models/courses');
const Transaction = require('../models/transactions');
const Appointment = require('../models/appointment');
const AuditLog = require('../models/auditLog');
const Notification = require('../models/notifications');
const AffiliateCommission = require('../models/affiliateCommission');
const { ensureAffiliateIdentity, generateUniqueAffiliateCode, joinedAt } = require('../utils/affiliateIdentity');
const { scopeIdOf } = require('../utils/actingOwner.js');
const { reverseCommission } = require('../services/affiliateCommissionService.js');
const {
  ACTIVE_STATUSES,
  DEACTIVATED_STATUSES,
  affiliateStatus,
} = require('../utils/affiliateStatus.js');
const { studentScope, escapeRegex, maskAccountNumber, toMajor } = require('./affiliateController.js');
const { sendMail, renderLayout, plainTextFallback, textToHtml } = require('../utils/emails/mailer.js');

// Branding for the message an administrator sends an affiliate, resolved the
// same way the other transactional emails resolve it so the console's mail
// matches everything else the platform sends.
const brandHomeUrl = (process.env.FRONTEND_URL || 'https://experthubllc.com').replace(/\/$/, '');
const trainingUrl = (process.env.TRAINING_URL || 'https://trainings.experthubllc.com').replace(/\/$/, '');
const logoUrl = `${trainingUrl}/images/logo.png`;
const supportEmail = process.env.MAIL_SUPPORT_EMAIL || 'support@experthubllc.com';

// The two states an administrator can move an affiliate between. There is no
// approval step: an affiliate is live from signup, so the only question the
// console asks is whether this account should currently be able to refer and earn.
const AFFILIATE_STATUSES = ['active', 'deactivated'];

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

function pagination(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function paged(records, total, { page, limit }) {
  return { records, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}

function logAudit({ req, action, entity, entityId, before, after, note }) {
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
 * The affiliate roster.
 *
 * Response shape follows the payment-records convention the rest of the admin
 * console uses — `{ records, summary, pagination }` — so the existing list-page
 * patterns can be reused rather than invented again.
 */
exports.listAffiliates = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);

    const filter = { role: 'affiliate' };

    // Matching the whole legacy family, not just the one word: until the status
    // migration has run, an affiliate switched off under the old model is stored
    // as `suspended` or `rejected`, and a filter for "deactivated" that only
    // looked for the new word would show an empty list rather than those accounts.
    const status = String(req.query.status || '').trim();
    if (status === 'active') {
      filter['affiliateProfile.status'] = { $in: ACTIVE_STATUSES };
    } else if (status === 'deactivated') {
      filter['affiliateProfile.status'] = { $in: DEACTIVATED_STATUSES };
    }

    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { fullname: pattern },
        { email: pattern },
        { organizationName: pattern },
        { affiliateId: pattern },
        { affiliateCode: pattern },
      ];
    }

    const [rows, total, statusCounts] = await Promise.all([
      User.find(filter)
        .select('fullname email phone organizationName affiliateId affiliateCode affiliateProfile balance createdAt blocked')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
      // Counts across the whole roster, not just this page, so the filter chips
      // show real totals rather than the page's own composition.
      User.aggregate([
        { $match: { role: 'affiliate' } },
        { $group: { _id: '$affiliateProfile.status', count: { $sum: 1 } } },
      ]),
    ]);

    // Earnings per affiliate for this page only — one aggregate rather than a
    // query per row.
    const ids = rows.map((row) => row._id);
    const earnings = ids.length
      ? await AffiliateCommission.aggregate([
          { $match: { affiliateId: { $in: ids }, status: { $in: ['pending', 'available', 'withdrawn'] } } },
          { $group: { _id: '$affiliateId', total: { $sum: '$amount' } } },
        ])
      : [];
    const earningsById = earnings.reduce((acc, row) => {
      acc[String(row._id)] = toMajor(row.total);
      return acc;
    }, {});

    // Counted through the same normaliser the rest of the code uses, so the
    // figures are right during the window where code has shipped but the status
    // migration has not yet run and the stored words are still the old ones.
    const summary = statusCounts.reduce(
      (acc, row) => {
        acc[affiliateStatus({ affiliateProfile: { status: row._id } })] += row.count;
        return acc;
      },
      { active: 0, deactivated: 0 }
    );

    // Every account on this page is given a serial if it lacks one, so the
    // roster cannot show "Not issued" beside an affiliate who is live and
    // earning. Only blanks are written, so after the first read of an affected
    // page this is a handful of no-op checks.
    const serials = await Promise.all(
      rows.map((row) =>
        ensureAffiliateIdentity(row).catch((error) => {
          // One failure must not blank the whole roster. The row keeps whatever
          // it had, which for a pre-serial account means the column stays as it
          // was until the next read rather than the page failing to load.
          console.error('Affiliate serial backfill failed:', error.message);
          return row.affiliateId || null;
        })
      )
    );

    const records = rows.map((row, index) => ({
      id: row._id,
      fullname: row.fullname,
      email: row.email,
      phone: row.phone,
      organizationName: row.affiliateProfile?.businessName || row.organizationName || null,
      affiliateId: serials[index] || null,
      affiliateCode: row.affiliateCode || null,
      status: affiliateStatus(row),
      balance: Number(row.balance) || 0,
      totalEarnings: earningsById[String(row._id)] || 0,
      blocked: row.blocked === true,
      createdAt: joinedAt(row),
    }));

    return res.json({ ...paged(records, total, { page, limit }), summary });
  } catch (error) {
    console.error('Admin affiliate list failed:', error);
    return res.status(500).json({ message: 'Could not load affiliates' });
  }
};

/**
 * The consolidated record for one affiliate (spec §19): their application, the
 * students they referred, what they have earned, what they have withdrawn, and
 * the audit trail of decisions taken about them.
 */
exports.getAffiliate = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid affiliate id' });

    const affiliate = await User.findOne({ _id: req.params.id, role: 'affiliate' }).lean();
    if (!affiliate) return res.status(404).json({ message: 'Affiliate not found' });

    const scope = studentScope(affiliate._id);

    const [students, studentsByStatus, commissionByStatus, commissions, withdrawals, appointments, history] =
      await Promise.all([
        User.find(scope)
          .select('fullname email phone admission status isVerified createdAt')
          .sort({ createdAt: -1 })
          .limit(100)
          .lean(),
        User.aggregate([
          { $match: scope },
          { $group: { _id: '$admission.status', count: { $sum: 1 } } },
        ]),
        AffiliateCommission.aggregate([
          { $match: { affiliateId: affiliate._id } },
          { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        ]),
        AffiliateCommission.find({ affiliateId: affiliate._id })
          .populate('studentId', 'fullname email')
          .populate('courseId', 'title')
          .sort({ createdAt: -1 })
          .limit(100)
          .lean(),
        Transaction.find({ userId: affiliate._id, 'metadata.purpose': 'withdrawal' })
          .sort({ date: -1 })
          .limit(50)
          .lean(),
        Appointment.find({ to: affiliate._id }).sort({ date: -1 }).limit(50).lean(),
        AuditLog.find({ entity: 'User', entityId: String(affiliate._id) }).sort({ at: -1 }).limit(50).lean(),
      ]);

    const commissionTotals = commissionByStatus.reduce((acc, row) => {
      acc[row._id] = { total: toMajor(row.total), count: row.count };
      return acc;
    }, {});

    // The detail view is where an admin goes to read the serial off the record,
    // so it is issued here too rather than only on the roster.
    const affiliateId = await ensureAffiliateIdentity(affiliate).catch((error) => {
      console.error('Affiliate serial backfill failed:', error.message);
      return affiliate.affiliateId || null;
    });

    return res.json({
      affiliate: {
        id: affiliate._id,
        fullname: affiliate.fullname,
        email: affiliate.email,
        phone: affiliate.phone,
        country: affiliate.country,
        state: affiliate.state,
        address: affiliate.address,
        affiliateId: affiliateId || null,
        affiliateCode: affiliate.affiliateCode || null,
        status: affiliateStatus(affiliate),
        blocked: affiliate.blocked === true,
        profilePicture: affiliate.image || affiliate.profilePicture || null,
        createdAt: joinedAt(affiliate),
        balance: Number(affiliate.balance) || 0,
        application: affiliate.affiliateProfile || {},
        commissionSettings: affiliate.affiliateSettings || {},
        bank: {
          bankName: affiliate.bankName || null,
          accountName: affiliate.accountName || null,
          // Masked even here: the admin console shows the destination, not a
          // credential worth copying out.
          accountNumber: maskAccountNumber(affiliate.accountNumber),
          hasPayoutAccount: Boolean(affiliate.bankCode && affiliate.accountNumber),
        },
      },
      students: students.map((row) => ({
        id: row._id,
        fullname: row.fullname,
        email: row.email,
        phone: row.phone,
        status: row.admission?.status || 'lead',
        isVerified: row.isVerified === true,
        createdAt: row.createdAt,
      })),
      admissions: studentsByStatus.map((row) => ({ status: row._id || 'lead', count: row.count })),
      earnings: {
        pending: commissionTotals.pending || { total: 0, count: 0 },
        available: commissionTotals.available || { total: 0, count: 0 },
        withdrawn: commissionTotals.withdrawn || { total: 0, count: 0 },
        reversed: commissionTotals.reversed || { total: 0, count: 0 },
      },
      commissions: commissions.map((row) => ({
        ref: row.commissionRef,
        amount: toMajor(row.amount),
        status: row.status,
        rateType: row.rateType,
        rateValue: row.rateValue,
        rateSource: row.rateSource,
        student: row.studentId ? { fullname: row.studentId.fullname, email: row.studentId.email } : null,
        course: row.courseId?.title || null,
        holdUntil: row.holdUntil,
        createdAt: row.createdAt,
      })),
      withdrawals: withdrawals.map((row) => ({
        id: row._id,
        amount: row.amount,
        status: row.status,
        date: row.date,
        reference: row.reference || row.txRef,
      })),
      appointments: appointments.map((row) => ({
        id: row._id,
        title: row.title || row.category,
        date: row.date,
        status: row.status || 'pending',
      })),
      history,
    });
  } catch (error) {
    console.error('Admin affiliate detail failed:', error);
    return res.status(500).json({ message: 'Could not load this affiliate' });
  }
};

/**
 * Switches an affiliate account on or off.
 *
 * There is no approval to give: an affiliate signs up active and can share their
 * link immediately, so the console's only lever is whether they should currently
 * be able to refer and earn. Switching off stops new commission accruing and
 * takes them out of the directory and the referral picker; it deliberately does
 * not touch attribution already recorded or earnings already banked, because
 * reversing those is a separate financial act with its own audit trail.
 *
 * A reason is welcome but optional. Deactivating is meant to be one deliberate
 * click — requiring prose would make administrators skip it in the cases that
 * matter — but whatever they write is kept, because "why was this affiliate
 * switched off" is the first question asked when the affiliate writes in.
 */
exports.updateAffiliateStatus = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid affiliate id' });

    const { status, reason, note } = req.body || {};

    if (!AFFILIATE_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Unknown affiliate status' });
    }

    const affiliate = await User.findOne({ _id: req.params.id, role: 'affiliate' });
    if (!affiliate) return res.status(404).json({ message: 'Affiliate not found' });

    const before = {
      status: affiliateStatus(affiliate),
      affiliateCode: affiliate.affiliateCode || null,
    };

    const now = new Date();
    const update = {
      'affiliateProfile.status': status,
      'affiliateProfile.reviewedAt': now,
      'affiliateProfile.reviewedBy': req.user.id,
    };

    if (note !== undefined) update['affiliateProfile.reviewNote'] = String(note).slice(0, 1000);

    if (status === 'active') {
      // Clearing rather than leaving a stale shutdown behind, so a reactivated
      // affiliate is not shown a reason that no longer applies.
      update['affiliateProfile.deactivationReason'] = null;
      update['affiliateProfile.deactivatedAt'] = null;
      update['affiliateProfile.deactivatedBy'] = null;
      update['affiliateProfile.suspensionReason'] = null;
      update['affiliateProfile.rejectionReason'] = null;

      // An affiliate who signed up before the referral code was issued at
      // registration — or who was switched off while it still was not — has none.
      // Reactivating them without one would leave them active and unable to refer,
      // which is the worst of both. The code is issued once and kept for life:
      // regenerating it on reactivation would break every link already shared.
      if (!affiliate.affiliateCode) {
        try {
          update.affiliateCode = await generateUniqueAffiliateCode();
        } catch (error) {
          console.error('Affiliate code allocation failed:', error.message);
          return res.status(500).json({ message: 'Could not issue a referral code. Please try again.' });
        }
      }
    }

    if (status === 'deactivated') {
      update['affiliateProfile.deactivatedAt'] = now;
      update['affiliateProfile.deactivatedBy'] = req.user.id;
      if (String(reason || '').trim()) {
        update['affiliateProfile.deactivationReason'] = String(reason).trim().slice(0, 500);
      }
    }

    // `findOneAndUpdate` with the role in the filter, so this can never touch a
    // non-affiliate account.
    const updated = await User.findOneAndUpdate(
      { _id: affiliate._id, role: 'affiliate' },
      { $set: update },
      { new: true }
    ).select('fullname email affiliateId affiliateCode affiliateProfile');

    if (!updated) return res.status(404).json({ message: 'Affiliate not found' });

    logAudit({
      req,
      action: `affiliate.${status}`,
      entity: 'User',
      entityId: affiliate._id,
      before,
      after: { status, affiliateCode: updated.affiliateCode || null, reason: reason ? String(reason).slice(0, 500) : null },
      note: note ? String(note).slice(0, 500) : undefined,
    });

    Notification.create({
      title: 'Affiliate account update',
      content:
        status === 'active'
          ? 'Your affiliate account is active. Your referral link is working.'
          : `Your affiliate account has been deactivated, so your referral link is no longer earning.${reason ? ` Reason: ${String(reason).slice(0, 300)}` : ''}`,
      contentId: String(affiliate._id),
      read: false,
      userId: affiliate._id,
    }).catch((error) => console.error('Affiliate status notification failed:', error.message));

    return res.json({
      message: status === 'active' ? 'Affiliate activated' : 'Affiliate deactivated',
      affiliate: {
        id: updated._id,
        status: updated.affiliateProfile?.status,
        affiliateId: updated.affiliateId || null,
        affiliateCode: updated.affiliateCode || null,
      },
    });
  } catch (error) {
    console.error('Admin affiliate status update failed:', error);
    return res.status(500).json({ message: 'Could not update this affiliate' });
  }
};

/**
 * Emails one affiliate from the admin console.
 *
 * Its own endpoint rather than reusing `POST /user/send-mail`. That one is the
 * tutor marketing composer: it is restricted to the tutor roles *and* refuses any
 * account without a paid plan, which no administrator has — so reusing it would
 * have answered every send from this console with a 403 about upgrading a plan
 * the caller cannot buy. It is also built around a markdown body and a call to
 * action button, neither of which this needs.
 *
 * The recipient is resolved from the record, never read from the body. An
 * endpoint that mails whatever address the caller names is a relay, and the
 * console only ever wants to reach the affiliate whose row the button was on.
 */
exports.sendAffiliateEmail = async (req, res) => {
  try {
    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();

    if (!subject) return res.status(400).json({ message: 'A subject is required' });
    if (!message) return res.status(400).json({ message: 'A message is required' });
    // Bounded so a console endpoint cannot be used to push an arbitrarily large
    // message through the shared mail transport.
    if (subject.length > 200) {
      return res.status(400).json({ message: 'Keep the subject under 200 characters' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ message: 'Keep the message under 5000 characters' });
    }

    // `role: 'affiliate'` in the filter, so an id belonging to any other kind of
    // account is a 404 rather than a mail sent to the wrong person.
    const affiliate = await User.findOne({ _id: req.params.id, role: 'affiliate' }).select(
      'fullname email affiliateId'
    );
    if (!affiliate) return res.status(404).json({ message: 'Affiliate not found' });
    if (!affiliate.email) {
      return res.status(400).json({ message: 'This affiliate has no email address on file' });
    }

    const sender = await User.findById(req.user.id).select('fullname email');
    const senderName = sender?.fullname || 'The ExpertHub team';

    const html = renderLayout('affiliate-message', {
      subject,
      preheader: message.slice(0, 140),
      emailHeading: subject,
      affiliateName: affiliate.fullname || 'there',
      // Built with textToHtml, which escapes before it formats: the message is
      // typed by hand into a console textarea, so it is HTML only once this has
      // made it so.
      messageHtml: textToHtml(message),
      senderName,
      affiliateId: affiliate.affiliateId || null,
      brandHomeUrl,
      logoUrl,
      supportEmail,
    });

    await sendMail({
      to: affiliate.email,
      subject,
      html,
      text: plainTextFallback([
        `Hello ${affiliate.fullname || 'there'},`,
        message,
        `Kind regards,\n${senderName}\nExpertHub Affiliate Programme`,
      ]),
      // Replies go to the person who wrote it, not to a no-reply mailbox. An
      // affiliate who answers an email about their account should reach a human.
      replyTo: sender?.email || undefined,
    });

    logAudit({
      req,
      action: 'affiliate.email',
      entity: 'User',
      entityId: affiliate._id,
      after: { subject, to: affiliate.email },
      note: subject,
    });

    return res.json({ message: `Email sent to ${affiliate.fullname || affiliate.email}` });
  } catch (error) {
    console.error('Admin affiliate email failed:', error);
    // Deliberately generic: the transport's own error can name the SMTP host and
    // credentials, which is not something to hand back over HTTP.
    return res.status(500).json({ message: 'Could not send that email. Please try again.' });
  }
};

/** Every commission on the platform, filterable by affiliate and status. */
exports.listCommissions = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);

    const filter = {};
    if (isObjectId(req.query.affiliateId)) filter.affiliateId = req.query.affiliateId;
    if (isObjectId(req.query.courseId)) filter.courseId = req.query.courseId;

    const status = String(req.query.status || '').trim();
    if (status) filter.status = status;

    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ commissionRef: pattern }, { sourceTransaction: pattern }];
    }

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
          rateSource: row.rateSource,
          baseAmount: toMajor(row.baseAmount),
          sourceTransaction: row.sourceTransaction,
          affiliate: row.affiliateId
            ? { id: row.affiliateId._id, fullname: row.affiliateId.fullname, affiliateId: row.affiliateId.affiliateId }
            : null,
          student: row.studentId ? { fullname: row.studentId.fullname, email: row.studentId.email } : null,
          course: row.courseId?.title || null,
          holdUntil: row.holdUntil,
          releasedAt: row.releasedAt,
          reversalReason: row.reversalReason || null,
          createdAt: row.createdAt,
        })),
        total,
        { page, limit }
      )
    );
  } catch (error) {
    console.error('Admin commission list failed:', error);
    return res.status(500).json({ message: 'Could not load commissions' });
  }
};

/**
 * Reverses a commission.
 *
 * The only caller of `reverseCommission`, because no refund or chargeback path
 * exists in the backend to trigger it automatically. Exposed here so staff can
 * act on a manual refund without a database edit.
 */
exports.reverseCommission = async (req, res) => {
  try {
    const ref = String(req.body?.ref || req.params.ref || '').trim();
    const reason = String(req.body?.reason || '').trim();

    if (!ref) return res.status(400).json({ message: 'A commission reference is required' });
    if (!reason) return res.status(400).json({ message: 'A reason is required' });

    const result = await reverseCommission(ref, { reason, actor: req.user.id });

    logAudit({
      req,
      action: 'commission.reversed',
      entity: 'AffiliateCommission',
      entityId: ref,
      after: { reason, debited: result.debited },
    });

    return res.json({
      message: result.debited
        ? 'Commission reversed and the affiliate balance adjusted'
        : 'Commission reversed. It had not been released, so no balance change was needed.',
      debited: result.debited,
    });
  } catch (error) {
    console.error('Commission reversal failed:', error);
    // A bad reference or a repeat reversal is user error, not a server fault.
    const known = ['not found', 'already been reversed', 'already a reversal', 'required'];
    const isUserError = known.some((fragment) => String(error.message || '').toLowerCase().includes(fragment));
    return res.status(isUserError ? 400 : 500).json({ message: error.message || 'Could not reverse this commission' });
  }
};

/**
 * The withdrawal queue.
 *
 * Read-only: payouts flow through the wallet's own hold-then-transfer path, so
 * there is nothing here to approve. This exists so staff can see affiliate
 * payouts that are pending or were refunded, which is where a failed payout
 * would surface. Presenting it as an approval queue would imply a gate that does
 * not exist.
 */
exports.listWithdrawals = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);

    const affiliateIds = await User.find({ role: 'affiliate' }).distinct('_id');

    const filter = { userId: { $in: affiliateIds }, 'metadata.purpose': 'withdrawal' };
    const status = String(req.query.status || '').trim();
    if (status) filter.status = status;

    const [rows, total] = await Promise.all([
      Transaction.find(filter)
        .populate('userId', 'fullname email affiliateId')
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
    ]);

    return res.json(
      paged(
        rows.map((row) => ({
          id: row._id,
          amount: row.amount,
          status: row.status,
          reference: row.reference || row.txRef,
          date: row.date,
          affiliate: row.userId
            ? { id: row.userId._id, fullname: row.userId.fullname, email: row.userId.email, affiliateId: row.userId.affiliateId }
            : null,
        })),
        total,
        { page, limit }
      )
    );
  } catch (error) {
    console.error('Admin withdrawal list failed:', error);
    return res.status(500).json({ message: 'Could not load withdrawals' });
  }
};

/** Platform-wide affiliate programme statistics for the admin overview. */
exports.stats = async (req, res) => {
  try {
    const [byStatus, commissionTotals, totalStudents, topAffiliates] = await Promise.all([
      User.aggregate([
        { $match: { role: 'affiliate' } },
        { $group: { _id: '$affiliateProfile.status', count: { $sum: 1 } } },
      ]),
      AffiliateCommission.aggregate([
        { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      User.countDocuments({ role: { $in: ['student', 'client'] }, referredByAffiliate: { $ne: null } }),
      AffiliateCommission.aggregate([
        { $match: { status: { $in: ['pending', 'available', 'withdrawn'] } } },
        { $group: { _id: '$affiliateId', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'affiliate' } },
        { $unwind: { path: '$affiliate', preserveNullAndEmptyArrays: true } },
      ]),
    ]);

    return res.json({
      // Normalised the same way as the roster, so the programme-wide figures and
      // the roster's own summary counts can never disagree about how many
      // affiliates are active.
      affiliates: byStatus.reduce(
        (acc, row) => {
          acc[affiliateStatus({ affiliateProfile: { status: row._id } })] += row.count;
          return acc;
        },
        { active: 0, deactivated: 0 }
      ),
      commissions: commissionTotals.reduce((acc, row) => {
        acc[row._id] = { total: toMajor(row.total), count: row.count };
        return acc;
      }, {}),
      referredStudents: totalStudents,
      topAffiliates: topAffiliates.map((row) => ({
        id: row._id,
        fullname: row.affiliate?.fullname || 'Unknown',
        affiliateId: row.affiliate?.affiliateId || null,
        total: toMajor(row.total),
      })),
    });
  } catch (error) {
    console.error('Admin affiliate stats failed:', error);
    return res.status(500).json({ message: 'Could not load statistics' });
  }
};

/** The audit trail, filterable by action and entity. */
exports.listAudit = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query, { defaultLimit: 50 });

    const filter = {};
    const action = String(req.query.action || '').trim();
    if (action) filter.action = action;

    const entityId = String(req.query.entityId || '').trim();
    if (entityId) filter.entityId = entityId;

    const [rows, total] = await Promise.all([
      AuditLog.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);

    return res.json(paged(rows, total, { page, limit }));
  } catch (error) {
    console.error('Admin audit list failed:', error);
    return res.status(500).json({ message: 'Could not load the audit trail' });
  }
};

/** Courses owned by this provider, for the per-course commission override UI. */
exports.listProviderCourses = async (req, res) => {
  try {
    const courses = await Course.find({ instructorId: scopeIdOf(req) })
      .select('title fee affiliateCommission')
      .sort({ title: 1 })
      .limit(200)
      .lean();

    return res.json({
      courses: courses.map((row) => ({
        id: row._id,
        title: row.title,
        fee: row.fee,
        affiliateCommission: row.affiliateCommission || null,
      })),
    });
  } catch (error) {
    console.error('Provider course list failed:', error);
    return res.status(500).json({ message: 'Could not load your courses' });
  }
};

/** Sets or clears the affiliate commission override on one of the provider's courses. */
exports.updateCourseCommission = async (req, res) => {
  try {
    if (!isObjectId(req.params.courseId)) return res.status(400).json({ message: 'Invalid course id' });

    const { enabled, type, value } = req.body || {};

    const update = {};

    if (enabled === null || enabled === undefined) {
      // Clearing the override returns the course to the provider default.
      update.affiliateCommission = { enabled: null, type: null, value: null };
    } else {
      if (typeof enabled !== 'boolean') return res.status(400).json({ message: 'Enabled must be true or false' });
      update['affiliateCommission.enabled'] = enabled;

      if (enabled && type !== undefined) {
        if (!['percentage', 'fixed'].includes(type)) {
          return res.status(400).json({ message: 'Commission type must be percentage or fixed' });
        }
        update['affiliateCommission.type'] = type;
      }
      if (enabled && value !== undefined) {
        const rate = Number(value);
        if (!Number.isFinite(rate) || rate < 0) {
          return res.status(400).json({ message: 'Commission value must be a number of 0 or more' });
        }
        update['affiliateCommission.value'] = rate;
      }
    }

    // Scoped by instructorId, so a provider can only change their own course. A
    // course they do not own resolves to null and its existence is not disclosed.
    const course = await Course.findOneAndUpdate(
      { _id: req.params.courseId, instructorId: scopeIdOf(req) },
      { $set: update },
      { new: true }
    ).select('title affiliateCommission');

    if (!course) return res.status(404).json({ message: 'Course not found' });

    logAudit({
      req,
      action: 'course_commission.updated',
      entity: 'Course',
      entityId: course._id,
      after: course.affiliateCommission,
    });

    return res.json({ message: 'Course commission updated', affiliateCommission: course.affiliateCommission });
  } catch (error) {
    console.error('Course commission update failed:', error);
    return res.status(500).json({ message: 'Could not update this course' });
  }
};

module.exports.AFFILIATE_STATUSES = AFFILIATE_STATUSES;
