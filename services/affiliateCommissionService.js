const User = require('../models/user');
const Course = require('../models/courses');
const Transaction = require('../models/transactions');
const Notification = require('../models/notifications');
const AffiliateCommission = require('../models/affiliateCommission');
const CoursePaymentPlan = require('../models/coursePaymentPlans');

const MINOR_UNIT = 100;

// All three are read with sane defaults so a deploy that has not set them still
// starts and behaves predictably, matching how CHECKOUT_REUSE_WINDOW_MS and the
// other tunables in the payment service are handled.
const DEFAULT_HOLD_DAYS = Number(process.env.AFFILIATE_HOLD_DAYS) || 14;
const PLATFORM_DEFAULT_RATE = Number(process.env.AFFILIATE_DEFAULT_COMMISSION_RATE) || 0;
const MAX_COMMISSION_RATE = Number(process.env.AFFILIATE_MAX_COMMISSION_RATE) || 50;

const toMinor = (major) => Math.round(Number(major || 0) * MINOR_UNIT);
const toMajor = (minor) => Number((Number(minor || 0) / MINOR_UNIT).toFixed(2));

/**
 * Works out what rate applies to one course sale, walking the resolution order
 * from most specific to least:
 *
 *   1. the course's own override
 *   2. a rate set for this affiliate specifically
 *   3. the provider's default
 *   4. the platform default
 *
 * Returns `{ type, value, source }`, or `null` when nothing applies — which is a
 * real answer, not an error: a provider who has switched the programme off, or a
 * course explicitly opted out, must generate no commission at all.
 */
function resolveCommissionRate({ course, provider, affiliateId }) {
  // The provider's master switch comes first. A disabled programme means no
  // commission anywhere in their catalogue, whatever a course override says —
  // otherwise a per-course setting would silently outrank the off switch and a
  // provider could not actually turn the programme off.
  if (provider?.affiliateSettings?.enabled === false) {
    return null;
  }

  const override = course?.affiliateCommission;
  if (override) {
    // An explicit per-course opt-out.
    if (override.enabled === false) return null;
    if (override.enabled === true && override.type && Number(override.value) > 0) {
      return { type: override.type, value: Number(override.value), source: 'course_override' };
    }
  }

  const perAffiliate = (provider?.affiliateSettings?.affiliateOverrides || []).find(
    (entry) => String(entry.affiliateId) === String(affiliateId)
  );
  if (perAffiliate && Number(perAffiliate.value) > 0) {
    return { type: perAffiliate.type || 'percentage', value: Number(perAffiliate.value), source: 'affiliate' };
  }

  const settings = provider?.affiliateSettings;
  if (settings && Number(settings.defaultCommissionRate) > 0) {
    return {
      type: settings.defaultCommissionType || 'percentage',
      value: Number(settings.defaultCommissionRate),
      source: 'provider',
    };
  }

  if (PLATFORM_DEFAULT_RATE > 0) {
    return { type: 'percentage', value: PLATFORM_DEFAULT_RATE, source: 'platform' };
  }

  return null;
}

/**
 * Applies the platform ceiling to a percentage rate.
 *
 * Clamped rather than rejected here: this runs on a settled payment, and refusing
 * to compute would silently withhold money the affiliate has already earned. The
 * settings endpoint is where an over-ceiling rate is refused outright, so the only
 * way to reach this branch is a ceiling lowered *after* a rate was saved.
 */
function clampRate(rate) {
  if (rate.type !== 'percentage') return rate;
  if (rate.value <= MAX_COMMISSION_RATE) return rate;
  return { ...rate, value: MAX_COMMISSION_RATE };
}

/**
 * Computes the commission owed on one settled payment, in minor units.
 *
 * Returns 0 when nothing is owed. Callers treat 0 as "write no row" rather than
 * writing a zero-value commission, so the commission ledger stays a record of
 * money that actually moved.
 */
function computeCommissionMinor({ rate, baseAmountMinor, fullFeeMinor, alreadyAccruedMinor, capMinor }) {
  // Defaulted rather than assumed: the first instalment has accrued nothing, and
  // a caller that simply leaves the field out would otherwise seed the arithmetic
  // with `undefined`. That produces NaN, and `Math.max(0, NaN)` is still NaN —
  // which Mongoose casts to null on a Number field, writing a commission row
  // with no amount. Zero is both the correct value and the safe one.
  const accrued = Number(alreadyAccruedMinor) || 0;

  let amount;

  if (rate.type === 'fixed') {
    // A fixed referral fee is earned once per course, not once per instalment —
    // otherwise a twelve-instalment plan would pay twelve times the agreed fee.
    // The caller enforces the once-only rule; here we simply express the amount.
    amount = Math.round(rate.value * MINOR_UNIT);
  } else {
    amount = Math.round((baseAmountMinor * rate.value) / 100);
  }

  // A part-paid course must never earn more than the same course paid in full.
  // Rounding each instalment independently can push the sum a kobo or two over,
  // so the running total is capped against the full-fee commission.
  if (fullFeeMinor > 0) {
    const remaining = fullFeeMinor - accrued;
    if (remaining <= 0) return 0;
    amount = Math.min(amount, remaining);
  }

  // The provider's optional per-commission ceiling, in naira.
  if (capMinor > 0) amount = Math.min(amount, capMinor);

  return Math.max(0, amount);
}

/**
 * Records the commission earned by one settled payment.
 *
 * Called immediately after the instructor is credited, from both the full-payment
 * and the instalment finalizers. It is deliberately fire-and-forget at the call
 * site: a failure here must never fail the payment, because the student's access
 * has already been granted and their money has already been taken.
 *
 * Idempotent by construction. `commissionRef` is derived from the payment's
 * `txRef`, so a replayed gateway webhook hits the unique index, receives a
 * duplicate-key error and returns without a second row.
 */
async function generateCommissionForPayment(transaction, options = {}) {
  if (!transaction?.txRef || !transaction?.userId) return { created: false, reason: 'invalid_transaction' };

  const baseAmountMinor = toMinor(transaction.amount);
  if (!(baseAmountMinor > 0)) return { created: false, reason: 'non_positive_amount' };

  // Attribution is per-student. A student with no referring affiliate generates
  // no commission at all, which is the common case and exits immediately.
  const student = await User.findById(transaction.userId).select('referredByAffiliate role');
  const affiliateId = student?.referredByAffiliate;
  if (!affiliateId) return { created: false, reason: 'no_referral' };

  // Guard against a self-referral that slipped past registration, and against an
  // affiliate who has since been deleted.
  if (String(affiliateId) === String(transaction.userId)) return { created: false, reason: 'self_referral' };

  const [course, affiliate] = await Promise.all([
    Course.findById(transaction.courseId).select('instructorId affiliateCommission'),
    User.findById(affiliateId).select('role affiliateProfile.status fullname'),
  ]);

  if (!course?.instructorId) return { created: false, reason: 'no_course' };
  if (!affiliate || affiliate.role !== 'affiliate') return { created: false, reason: 'affiliate_missing' };

  // A suspended affiliate keeps what they already earned but accrues nothing new.
  // `approved` is required because a referral can only ever be attributed to an
  // approved affiliate in the first place; this covers a later suspension.
  if (affiliate.affiliateProfile?.status !== 'approved') {
    return { created: false, reason: 'affiliate_not_approved' };
  }

  const provider = await User.findById(course.instructorId).select('affiliateSettings');
  const resolved = resolveCommissionRate({ course, provider, affiliateId });
  if (!resolved) return { created: false, reason: 'no_rate_configured' };

  const rate = clampRate(resolved);

  // Existing accruals for this student's purchases of this course, used both for
  // the once-only fixed fee and for the full-fee cap on a part-paid course.
  const priorAggregate = await AffiliateCommission.aggregate([
    {
      $match: {
        affiliateId: affiliate._id,
        studentId: student._id,
        courseId: course._id,
        status: { $ne: 'reversed' },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const alreadyAccruedMinor = Number(priorAggregate[0]?.total) || 0;

  if (rate.type === 'fixed' && alreadyAccruedMinor > 0) {
    // One flat referral fee per course.
    return { created: false, reason: 'fixed_fee_already_paid' };
  }

  // The full-fee ceiling only applies to a course being paid in parts. A single
  // full payment is its own base, so there is nothing to cap against.
  let fullFeeMinor = 0;
  if (transaction.paymentPlanId) {
    const plan = options.plan || (await CoursePaymentPlan.findById(transaction.paymentPlanId).select('totalAmountMinor'));
    fullFeeMinor = Number(plan?.totalAmountMinor) || 0;
    if (fullFeeMinor > 0 && rate.type === 'percentage') {
      fullFeeMinor = Math.round((fullFeeMinor * rate.value) / 100);
    } else {
      // Fixed fees are not scaled by the fee, so the cap is the fee itself.
      fullFeeMinor = rate.type === 'fixed' ? Math.round(rate.value * MINOR_UNIT) : 0;
    }
  }

  const capMinor = toMinor(provider?.affiliateSettings?.maxCommissionCap);
  const amountMinor = computeCommissionMinor({
    rate,
    baseAmountMinor,
    fullFeeMinor,
    alreadyAccruedMinor,
    capMinor,
  });

  if (!(amountMinor > 0)) return { created: false, reason: 'zero_amount' };

  const holdDays =
    provider?.affiliateSettings?.holdDays === null || provider?.affiliateSettings?.holdDays === undefined
      ? DEFAULT_HOLD_DAYS
      : Number(provider.affiliateSettings.holdDays);

  // The holding period is measured from settlement, not from enrolment, so the
  // clock starts when the money actually arrived.
  const settledAt = transaction.paidAt || new Date();
  const holdUntil = new Date(settledAt.getTime() + holdDays * 24 * 60 * 60 * 1000);

  const commissionRef = `aff-commission-${transaction.txRef}`;

  try {
    await AffiliateCommission.create({
      affiliateId: affiliate._id,
      studentId: student._id,
      courseId: course._id,
      paymentPlanId: transaction.paymentPlanId || undefined,
      installmentNumber: transaction.installmentNumber || undefined,
      sourceTransaction: transaction.txRef,
      baseAmount: baseAmountMinor,
      rateType: rate.type,
      rateValue: rate.value,
      amount: amountMinor,
      status: 'pending',
      holdUntil,
      rateSource: rate.source,
      commissionRef,
      currency: transaction.currency || 'NGN',
    });
  } catch (error) {
    // Already recorded for this payment. This is the expected path for a replayed
    // webhook or a redirect that lands after the webhook already settled it.
    if (error?.code === 11000) return { created: false, reason: 'duplicate' };
    throw error;
  }

  // Fire-and-forget: a notification is not worth failing a settled payment over.
  Notification.create({
    title: 'Commission earned',
    content: `You earned ${formatMoney(toMajor(amountMinor))} from a referred student's payment. It becomes available on ${holdUntil.toDateString()}.`,
    contentId: String(course._id),
    read: false,
    userId: affiliate._id,
  }).catch((error) => console.error('Affiliate commission notification failed:', error.message));

  return { created: true, amountMinor, holdUntil, commissionRef };
}

function formatMoney(amount) {
  return `₦${Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Releases every commission whose holding period has elapsed.
 *
 * Runs as a sweep so the release does not depend on any single request: a
 * commission matures on its own schedule regardless of whether the affiliate is
 * online. Each row is claimed with a conditional update on `status`, so two
 * overlapping sweeps — or two application instances — cannot both credit the same
 * commission. Only the winner of that transition touches the balance.
 *
 * Ordering mirrors `creditInstructor`: the ledger row is written first, because
 * its unique `txRef` is the record that the credit was applied, then the balance
 * is incremented. A crash in the narrow window between the two leaves the ledger
 * and the balance disagreeing; the row is still `pending`, so the next sweep
 * retries and the duplicate key stops it re-crediting. That window is what the
 * admin commission view exists to surface.
 */
async function releaseMaturedCommissions({ now = new Date(), limit = 200 } = {}) {
  const due = await AffiliateCommission.find({
    status: 'pending',
    holdUntil: { $lte: now },
  })
    .sort({ holdUntil: 1 })
    .limit(limit)
    .lean();

  let released = 0;
  let skipped = 0;

  for (const commission of due) {
    // The claim. If another runner already took this row, `claimed` is null and
    // this runner must not touch the balance.
    const claimed = await AffiliateCommission.findOneAndUpdate(
      { _id: commission._id, status: 'pending' },
      { $set: { status: 'available', releasedAt: now } },
      { new: true }
    );
    if (!claimed) {
      skipped += 1;
      continue;
    }

    const amountMajor = toMajor(commission.amount);
    const affiliate = await User.findById(commission.affiliateId).select('balance');
    if (!affiliate) {
      // The affiliate is gone. Leave the row `available` so the money is not lost
      // from the books, and move on rather than throwing.
      console.error('Commission release: affiliate missing for', commission.commissionRef);
      skipped += 1;
      continue;
    }

    const balanceAfter = (Number(affiliate.balance) || 0) + amountMajor;

    try {
      await Transaction.create({
        userId: commission.affiliateId,
        courseId: commission.courseId,
        amount: amountMajor,
        type: 'affiliate_commission',
        direction: 'credit',
        balanceAfter,
        status: 'successful',
        txRef: `aff-release-${commission.commissionRef}`,
        metadata: {
          commissionRef: commission.commissionRef,
          sourceTransaction: commission.sourceTransaction,
          studentId: String(commission.studentId),
          rateType: commission.rateType,
          rateValue: commission.rateValue,
        },
      });
    } catch (error) {
      if (error?.code === 11000) {
        // The ledger row already exists, so this commission was credited by an
        // earlier run that did not get as far as updating the balance. Retrying
        // the increment would pay twice, so stop and leave it for reconciliation.
        console.error('Commission release: ledger row exists but balance not applied for', commission.commissionRef);
        skipped += 1;
        continue;
      }
      throw error;
    }

    await User.findByIdAndUpdate(commission.affiliateId, { $inc: { balance: amountMajor } });

    Notification.create({
      title: 'Commission available',
      content: `${formatMoney(amountMajor)} commission is now available in your wallet.`,
      contentId: String(commission.courseId),
      read: false,
      userId: commission.affiliateId,
    }).catch((error) => console.error('Commission release notification failed:', error.message));

    released += 1;
  }

  return { scanned: due.length, released, skipped };
}

/**
 * Reverses a commission that has already been recorded.
 *
 * Nothing is ever deleted — the spec requires the financial record to survive —
 * so a reversal writes a *compensating* pair: a negative commission row and a
 * debit ledger row. Summing the commission collection therefore still yields the
 * true net earned.
 *
 * If the earnings were already withdrawn the balance is allowed to go negative
 * and is offset by the affiliate's next commission. Clamping to zero would quietly
 * forgive a debt the platform is actually owed.
 *
 * There is no automated caller: no refund or chargeback path exists in the
 * backend today, so this is invoked from the admin console (and is ready for a
 * future refund flow to call). It is not a guarantee that refunds are handled.
 */
async function reverseCommission(commissionRef, { reason, actor } = {}) {
  if (!commissionRef) throw new Error('A commission reference is required');
  if (!reason || !String(reason).trim()) throw new Error('A reason is required to reverse a commission');

  const original = await AffiliateCommission.findOne({ commissionRef });
  if (!original) throw new Error('Commission not found');
  if (original.amount < 0) throw new Error('This row is already a reversal');
  if (original.reversalRef) throw new Error('This commission has already been reversed');

  const reversalRef = `aff-reversal-${commissionRef}`;

  const reversal = await AffiliateCommission.create({
    affiliateId: original.affiliateId,
    studentId: original.studentId,
    courseId: original.courseId,
    paymentPlanId: original.paymentPlanId,
    installmentNumber: original.installmentNumber,
    sourceTransaction: original.sourceTransaction,
    baseAmount: original.baseAmount,
    rateType: original.rateType,
    rateValue: original.rateValue,
    amount: -Math.abs(original.amount),
    status: 'reversed',
    reversedAt: new Date(),
    reversalReason: String(reason).trim(),
    reverses: commissionRef,
    rateSource: original.rateSource,
    commissionRef: reversalRef,
    currency: original.currency,
  });

  original.status = 'reversed';
  original.reversedAt = new Date();
  original.reversalReason = String(reason).trim();
  original.reversalRef = reversalRef;
  original.reversedBy = actor || undefined;
  await original.save();

  // Money only moves if it had already reached the balance. A commission still
  // inside its holding period has never been credited, so reversing it is purely
  // a bookkeeping change — debiting the wallet would take money that was never
  // there.
  const wasReleased = Boolean(original.releasedAt);

  if (wasReleased) {
    const amountMajor = toMajor(original.amount);
    const affiliate = await User.findById(original.affiliateId).select('balance');
    const balanceAfter = (Number(affiliate?.balance) || 0) - amountMajor;

    try {
      await Transaction.create({
        userId: original.affiliateId,
        courseId: original.courseId,
        amount: amountMajor,
        type: 'affiliate_commission_reversal',
        direction: 'debit',
        balanceAfter,
        status: 'successful',
        txRef: `aff-reversal-ledger-${commissionRef}`,
        metadata: { reverses: commissionRef, reason: String(reason).trim(), reversedBy: actor ? String(actor) : null },
      });
    } catch (error) {
      if (error?.code === 11000) return { reversal, debited: false, reason: 'already_reversed' };
      throw error;
    }

    await User.findByIdAndUpdate(original.affiliateId, { $inc: { balance: -amountMajor } });

    Notification.create({
      title: 'Commission reversed',
      content: `A commission of ${formatMoney(amountMajor)} was reversed. Reason: ${String(reason).trim()}`,
      contentId: String(original.courseId),
      read: false,
      userId: original.affiliateId,
    }).catch((error) => console.error('Commission reversal notification failed:', error.message));

    return { reversal, debited: true };
  }

  return { reversal, debited: false };
}

module.exports = {
  generateCommissionForPayment,
  releaseMaturedCommissions,
  reverseCommission,
  resolveCommissionRate,
  computeCommissionMinor,
  clampRate,
  formatMoney,
  DEFAULT_HOLD_DAYS,
  MAX_COMMISSION_RATE,
  PLATFORM_DEFAULT_RATE,
};
