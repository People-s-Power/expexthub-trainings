const User = require('../models/user');
const Course = require('../models/courses');
const Transaction = require('../models/transactions');
const Notification = require('../models/notifications');
const AffiliateCommission = require('../models/affiliateCommission');
const CoursePaymentPlan = require('../models/coursePaymentPlans');
const { isAffiliateActive } = require('../utils/affiliateStatus.js');
const {
  MINOR_UNIT,
  MAX_SHARE_PERCENT,
  clampPercentage,
} = require('../utils/revenueShare.js');

// All three are read with sane defaults so a deploy that has not set them still
// starts and behaves predictably, matching how CHECKOUT_REUSE_WINDOW_MS and the
// other tunables in the payment service are handled.
const DEFAULT_HOLD_DAYS = Number(process.env.AFFILIATE_HOLD_DAYS) || 14;
const PLATFORM_DEFAULT_RATE = Number(process.env.AFFILIATE_DEFAULT_COMMISSION_RATE) || 0;
// The ceiling is shared with the tutor revenue share — see utils/revenueShare.js.
// Two different ceilings on the same naira would let a provider pay out more in
// total than either setting suggests it allows.
const MAX_COMMISSION_RATE = MAX_SHARE_PERCENT;

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
 *
 * The clamp itself is shared with the tutor revenue share
 * (utils/revenueShare.js) so the two cannot end up enforcing different ceilings.
 */
function clampRate(rate) {
  if (rate.type !== 'percentage') return rate;
  const value = clampPercentage(rate.value, MAX_COMMISSION_RATE);
  if (value === rate.value) return rate;
  return { ...rate, value };
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
  const student = await User.findById(transaction.userId).select('referredByAffiliate role fullname');
  const affiliateId = student?.referredByAffiliate;
  if (!affiliateId) return { created: false, reason: 'no_referral' };

  // Guard against a self-referral that slipped past registration, and against an
  // affiliate who has since been deleted.
  if (String(affiliateId) === String(transaction.userId)) return { created: false, reason: 'self_referral' };

  const [course, affiliate] = await Promise.all([
    Course.findById(transaction.courseId).select('instructorId affiliateCommission title'),
    User.findById(affiliateId).select('role affiliateProfile.status fullname'),
  ]);

  if (!course?.instructorId) return { created: false, reason: 'no_course' };
  if (!affiliate || affiliate.role !== 'affiliate') return { created: false, reason: 'affiliate_missing' };

  // A deactivated affiliate keeps what they already earned but accrues nothing
  // new. Attribution can only ever land on an affiliate who was active at the
  // time, so this covers someone switched off between the referral and the
  // payment finally settling.
  if (!isAffiliateActive(affiliate)) {
    return { created: false, reason: 'affiliate_not_active' };
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
  //
  // The student and course are named because this notification is a link into the
  // wallet, where the same affiliate may be looking at several commissions. "You
  // earned ₦X from a referred student's payment" gave them nothing to match the
  // row against once they arrived.
  Notification.create({
    title: 'Commission earned',
    content: `You earned ${formatMoney(toMajor(amountMinor))} when ${student.fullname || 'a referred student'} paid for ${course.title || 'a course'}. It becomes available on ${holdUntil.toDateString()}.`,
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
 * Chooses which available commissions a withdrawal consumes.
 *
 * Pure, and exported, so the arithmetic can be tested without a database — the
 * same reason `resolveCommissionRate` and `computeCommissionMinor` are.
 *
 * Takes the affiliate's available commission amounts in **minor units**, in the
 * order they should be consumed (oldest first), and the withdrawal in minor
 * units. Returns the indexes that are fully covered, plus whatever the
 * commissions could not cover.
 *
 * A row the withdrawal only *partly* covers is deliberately left out, and
 * consumption stops there. It stays `available`, because the rest of it is still
 * withdrawable and marking it withdrawn would hide money the affiliate can still
 * claim — and an affiliate withdrawing part of a single commission is the
 * ordinary case, not an edge one. Leaving it available is also what keeps
 * `availableEarnings` on the wallet honest: it goes on meaning "still
 * withdrawable", not "not yet paid out in full".
 */
function allocateWithdrawal(availableMinor, withdrawMinor) {
  const coveredIndexes = [];
  let remaining = Math.max(0, Number(withdrawMinor) || 0);

  for (let index = 0; index < availableMinor.length && remaining > 0; index += 1) {
    const amount = Math.max(0, Number(availableMinor[index]) || 0);
    if (amount === 0) continue;
    if (amount > remaining) {
      // Partly covered, so not consumed: this row absorbs the rest of the
      // withdrawal, but it stays `available` and is not listed.
      remaining = 0;
      break;
    }
    coveredIndexes.push(index);
    remaining -= amount;
  }

  // Whatever a commission could not absorb came from balance that was never
  // commission — a manual credit, or earnings from another role. Normal, and not
  // an error. Only an amount no row could cover at all is reported here; a
  // part-consumed row still absorbed its share.
  return { coveredIndexes, uncoveredMinor: remaining };
}

/**
 * Marks the earnings a confirmed withdrawal consumed as withdrawn.
 *
 * Oldest first, and only rows the payout covers in full (see allocateWithdrawal).
 * Called once the payout is *confirmed*, never when it is merely requested: a
 * queued transfer has paid nobody yet, and marking on request would show the
 * money as gone while it was still in flight — and would have to be undone on
 * every refund.
 *
 * Idempotent by the `status: 'available'` guard on the update, so a replayed
 * webhook, the redirect path and the reconciliation sweep can all call it and
 * only the first one moves anything.
 *
 * Without this the wallet was simply wrong: the payout debited `User.balance`
 * and wrote its ledger row, but nothing ever moved the commissions behind it, so
 * "Available to withdraw" never fell and no row ever read Withdrawn.
 */
async function applyWithdrawalToCommissions({ affiliateId, amountMajor, withdrawalRef, now = new Date() }) {
  if (!affiliateId || !withdrawalRef) return { withdrawn: 0 };

  const amountMinor = toMinor(amountMajor);
  if (!(amountMinor > 0)) return { withdrawn: 0 };

  // Ordered by when the earning became withdrawable, so the oldest money is
  // spent first. `_id` breaks ties, since two rows released in the same
  // millisecond would otherwise be consumed in an arbitrary order.
  const rows = await AffiliateCommission.find({ affiliateId, status: 'available' })
    .sort({ releasedAt: 1, createdAt: 1, _id: 1 })
    .select('_id amount')
    .lean();

  const { coveredIndexes } = allocateWithdrawal(
    rows.map((row) => Number(row.amount) || 0),
    amountMinor,
  );
  if (!coveredIndexes.length) return { withdrawn: 0 };

  const result = await AffiliateCommission.updateMany(
    { _id: { $in: coveredIndexes.map((index) => rows[index]._id) }, status: 'available' },
    { $set: { status: 'withdrawn', withdrawnAt: now, withdrawnByRef: withdrawalRef } },
  );

  return { withdrawn: result.modifiedCount || 0 };
}

/**
 * Puts back the earnings a refunded withdrawal had consumed.
 *
 * A payout that failed or was reversed never reached the bank, so its hold is
 * credited back to the balance and the earnings behind it have to read as
 * available again. Without this a failed withdrawal would consume them for good
 * and the affiliate could never withdraw that money a second time.
 *
 * Keyed on `withdrawnByRef`, which is why the withdrawal reference is recorded
 * on the row rather than inferred — a later withdrawal of the same size must not
 * have its rows mistaken for this one's.
 */
async function restoreCommissionsForWithdrawal(withdrawalRef) {
  if (!withdrawalRef) return { restored: 0 };

  const result = await AffiliateCommission.updateMany(
    { withdrawnByRef: withdrawalRef, status: 'withdrawn' },
    { $set: { status: 'available' }, $unset: { withdrawnAt: 1, withdrawnByRef: 1 } },
  );

  return { restored: result.modifiedCount || 0 };
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
  applyWithdrawalToCommissions,
  restoreCommissionsForWithdrawal,
  allocateWithdrawal,
  resolveCommissionRate,
  computeCommissionMinor,
  clampRate,
  formatMoney,
  DEFAULT_HOLD_DAYS,
  MAX_COMMISSION_RATE,
  PLATFORM_DEFAULT_RATE,
};
