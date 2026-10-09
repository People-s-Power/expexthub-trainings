const mongoose = require('mongoose');
const User = require('../models/user');
const Transaction = require('../models/transactions');
const Notification = require('../models/notifications');
const TutorEarning = require('../models/tutorEarning');
const {
  MINOR_UNIT,
} = require('../utils/revenueShare.js');
// The withdrawal allocation rule and the money formatter are the same arithmetic
// the affiliate ledger uses, and deliberately not copied: `allocateWithdrawal` is
// pure and decides which available rows a payout consumes in full, and two copies
// of that rule is how the two ledgers start disagreeing about which money a
// withdrawal spent. `affiliateCommissionService` requires nothing that requires
// this module, so importing from it closes no cycle.
const {
  allocateWithdrawal,
  formatMoney,
} = require('./affiliateCommissionService.js');

// Read with a sane default so a deploy that has not set it still starts and
// behaves predictably, matching AFFILIATE_HOLD_DAYS and the other tunables.
const DEFAULT_HOLD_DAYS = Number(process.env.TUTOR_HOLD_DAYS) || 14;

const toMinor = (major) => Math.round(Number(major || 0) * MINOR_UNIT);
const toMajor = (minor) => Number((Number(minor || 0) / MINOR_UNIT).toFixed(2));

/**
 * The unique key of one earning: this payment, this tutor.
 *
 * Exported so the idempotency property can be checked without a database — the
 * whole reason a replayed webhook cannot pay a tutor twice is that this string is
 * the same both times, and that is worth being able to prove rather than assume.
 * Both components are needed: the payment alone would collide across the tutors on
 * one course, and the tutor alone would collide across their payments.
 */
const earningRefFor = (txRef, tutorId) => `tutor-earning-${txRef}-${tutorId}`;

/**
 * How much this student's tutoring on this course has already earned.
 *
 * Two rules read this, and both are about the course's *pool* of tutors rather
 * than about any one of them:
 *
 *  - the fixed fee is paid once per course, so a second payment must not pay it
 *    again;
 *  - the provider's optional cap is a true running total per student, so a later
 *    instalment must see what the earlier ones spent.
 *
 * Keyed on (student, course) and summed in one go for exactly that reason: keying
 * it per tutor would make a provider who set "₦5,000 per student" and assigned
 * three tutors pay ₦15,000, which is the label-versus-code gap this replaces.
 *
 * Reversed rows are excluded, so a reversal genuinely un-does the accrual rather
 * than leaving the cap consumed by money that was given back.
 *
 * Cast to `ObjectId` deliberately. The affiliate's equivalent matches ids that
 * came off `findById`; this one is handed `transaction.userId`, which is a string.
 * `aggregate` does not cast, so a string matched against ObjectId-stored rows
 * returns nothing — the cap would never bite and the fee would be paid repeatedly,
 * with no error anywhere to say so.
 */
async function accruedTutorShareForStudentCourse({ studentId, courseId } = {}) {
  if (!studentId || !courseId) return { totalMinor: 0 };
  if (!mongoose.Types.ObjectId.isValid(String(studentId)) || !mongoose.Types.ObjectId.isValid(String(courseId))) {
    return { totalMinor: 0 };
  }

  const accrued = await TutorEarning.aggregate([
    {
      $match: {
        studentId: new mongoose.Types.ObjectId(String(studentId)),
        courseId: new mongoose.Types.ObjectId(String(courseId)),
        status: { $ne: 'reversed' },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return { totalMinor: Number(accrued[0]?.total) || 0 };
}

/**
 * Records the tutor earnings accrued by one settled payment.
 *
 * Called from `creditInstructor` immediately after the provider is credited, from
 * both the full-payment and the instalment finalizers. It is deliberately
 * fire-and-forget at the call site: a failure here must never fail the payment,
 * because the student's access has already been granted and their money has
 * already been taken.
 *
 * The tutor slices are **passed in**, already computed by `splitCourseEarnings`,
 * rather than re-derived here. That is the whole point: the provider's residual
 * and these rows are two halves of one division, and computing them separately
 * invites the two to disagree by a kobo — which would show up as a ledger that
 * does not reconcile against what the provider was actually paid. The amount paid
 * and the amount recorded are therefore the same number by construction.
 *
 * Idempotent by construction. `earningRef` is derived from the payment's `txRef`
 * and the tutor, so a replayed gateway webhook hits the unique index, receives a
 * duplicate-key error and writes no second row.
 */
async function generateTutorEarningsForPayment(transaction, options = {}) {
  if (!transaction?.txRef || !transaction?.userId) {
    return { created: 0, reason: 'invalid_transaction' };
  }

  const baseAmountMinor = toMinor(transaction.amount);
  if (!(baseAmountMinor > 0)) return { created: 0, reason: 'non_positive_amount' };

  const { course, provider, rateSource } = options;
  // The rate the split actually used, snapshotted onto the row. `rateType` decides
  // how `rateValue` reads — a percentage, or naira for a fixed fee — so the two
  // have to travel together.
  const rateType = options.rateType === 'fixed' ? 'fixed' : 'percentage';
  const rateValue = Number(options.value) || 0;
  // Only the tutor slices are the ledger's business. The provider's own share is
  // a wallet credit, not an earning, and including it here would double-count it.
  const tutorShares = (options.shares || []).filter((share) => share?.role === 'tutor' && share.amount > 0);
  if (!tutorShares.length) return { created: 0, reason: 'no_tutor_shares' };
  if (!course?._id) return { created: 0, reason: 'no_course' };

  const holdDays =
    provider?.tutorRevenueShare?.holdDays === null || provider?.tutorRevenueShare?.holdDays === undefined
      ? DEFAULT_HOLD_DAYS
      : Number(provider.tutorRevenueShare.holdDays);

  // The holding period is measured from settlement, not from enrolment, so the
  // clock starts when the money actually arrived.
  const settledAt = transaction.paidAt || new Date();
  const holdUntil = new Date(settledAt.getTime() + holdDays * 24 * 60 * 60 * 1000);

  // Named in the notification so a tutor looking at several earnings can match
  // the row against the message that announced it.
  const student = await User.findById(transaction.userId).select('fullname');
  const studentName = student?.fullname || 'a student';
  const courseTitle = course.title || 'a course';

  let created = 0;
  const rows = [];

  for (const share of tutorShares) {
    const earningRef = earningRefFor(transaction.txRef, share.userId);

    let row;
    try {
      row = await TutorEarning.create({
        tutorId: share.userId,
        studentId: transaction.userId,
        courseId: course._id,
        providerId: course.instructorId || provider?._id || undefined,
        paymentPlanId: transaction.paymentPlanId || undefined,
        installmentNumber: transaction.installmentNumber || undefined,
        sourceTransaction: transaction.txRef,
        baseAmount: baseAmountMinor,
        rateType,
        rateValue,
        amount: toMinor(share.amount),
        status: 'pending',
        holdUntil,
        rateSource: rateSource || undefined,
        earningRef,
        currency: transaction.currency || 'NGN',
      });
    } catch (error) {
      // Already recorded for this payment and tutor. This is the expected path for
      // a replayed webhook or a redirect that lands after the webhook settled it.
      if (error?.code === 11000) continue;
      throw error;
    }

    // Fire-and-forget: a notification is not worth failing a settled payment over.
    Notification.create({
      title: 'Earning in holding',
      content: `You earned ${formatMoney(share.amount)} when ${studentName} paid for ${courseTitle}. It becomes available on ${holdUntil.toDateString()}.`,
      contentId: String(course._id),
      read: false,
      userId: share.userId,
    }).catch((error) => console.error('Tutor earning notification failed:', error.message));

    created += 1;
    rows.push({ earningRef, rowId: row._id, tutorId: share.userId, amountMinor: row.amount, holdUntil });
  }

  if (!created) return { created: 0, reason: 'duplicate' };
  return { created, rows, holdUntil };
}

/**
 * Releases every tutor earning whose holding period has elapsed.
 *
 * Runs as a sweep so the release does not depend on any single request: an earning
 * matures on its own schedule regardless of whether the tutor is online. Each row
 * is claimed with a conditional update on `status`, so two overlapping sweeps — or
 * two application instances — cannot both credit the same earning. Only the winner
 * of that transition touches the balance.
 *
 * Ordering mirrors `releaseMaturedCommissions` and `creditShare`: the ledger row is
 * written first, because its unique `txRef` is the record that the credit was
 * applied, then the balance is incremented. A crash in the narrow window between
 * the two leaves the ledger and the balance disagreeing; the row is still
 * `pending`, so the next sweep retries and the duplicate key stops it re-crediting.
 */
async function releaseMaturedEarnings({ now = new Date(), limit = 200 } = {}) {
  const due = await TutorEarning.find({
    status: 'pending',
    holdUntil: { $lte: now },
  })
    .sort({ holdUntil: 1 })
    .limit(limit)
    .lean();

  let released = 0;
  let skipped = 0;

  for (const earning of due) {
    // The claim. If another runner already took this row, `claimed` is null and
    // this runner must not touch the balance.
    const claimed = await TutorEarning.findOneAndUpdate(
      { _id: earning._id, status: 'pending' },
      { $set: { status: 'available', releasedAt: now } },
      { new: true }
    );
    if (!claimed) {
      skipped += 1;
      continue;
    }

    const amountMajor = toMajor(earning.amount);
    const tutor = await User.findById(earning.tutorId).select('balance');
    if (!tutor) {
      // The tutor is gone. Leave the row `available` so the money is not lost from
      // the books, and move on rather than throwing.
      console.error('Tutor earning release: tutor missing for', earning.earningRef);
      skipped += 1;
      continue;
    }

    const balanceAfter = (Number(tutor.balance) || 0) + amountMajor;

    try {
      await Transaction.create({
        userId: earning.tutorId,
        courseId: earning.courseId,
        amount: amountMajor,
        type: 'tutor_earning',
        direction: 'credit',
        balanceAfter,
        status: 'successful',
        txRef: `tutor-release-${earning.earningRef}`,
        metadata: {
          earningRef: earning.earningRef,
          sourceTransaction: earning.sourceTransaction,
          courseId: String(earning.courseId),
          rateType: earning.rateType,
          rateValue: earning.rateValue,
        },
      });
    } catch (error) {
      if (error?.code === 11000) {
        // The ledger row already exists, so this earning was credited by an earlier
        // run that did not get as far as updating the balance. Retrying the
        // increment would pay twice, so stop and leave it for reconciliation.
        console.error('Tutor earning release: ledger row exists but balance not applied for', earning.earningRef);
        skipped += 1;
        continue;
      }
      throw error;
    }

    await User.findByIdAndUpdate(earning.tutorId, { $inc: { balance: amountMajor } });

    Notification.create({
      title: 'Earning available',
      content: `${formatMoney(amountMajor)} from your tutoring is now available in your wallet.`,
      contentId: String(earning.courseId),
      read: false,
      userId: earning.tutorId,
    }).catch((error) => console.error('Tutor earning release notification failed:', error.message));

    released += 1;
  }

  return { scanned: due.length, released, skipped };
}

/**
 * Marks the earnings a confirmed withdrawal consumed as withdrawn.
 *
 * Oldest first, and only rows the payout covers in full (see `allocateWithdrawal`).
 * Called once the payout is *confirmed*, never when it is merely requested: a
 * queued transfer has paid nobody yet, and marking on request would show the money
 * as gone while it was still in flight — and would have to be undone on every
 * refund.
 *
 * Idempotent by the `status: 'available'` guard on the update, so a replayed
 * webhook, the redirect path and the reconciliation sweep can all call it and only
 * the first one moves anything.
 */
async function applyWithdrawalToEarnings({ tutorId, amountMajor, withdrawalRef, now = new Date() }) {
  if (!tutorId || !withdrawalRef) return { withdrawn: 0 };

  const amountMinor = toMinor(amountMajor);
  if (!(amountMinor > 0)) return { withdrawn: 0 };

  // Ordered by when the earning became withdrawable, so the oldest money is spent
  // first. `_id` breaks ties, since two rows released in the same millisecond would
  // otherwise be consumed in an arbitrary order.
  const rows = await TutorEarning.find({ tutorId, status: 'available' })
    .sort({ releasedAt: 1, createdAt: 1, _id: 1 })
    .select('_id amount')
    .lean();

  const { coveredIndexes } = allocateWithdrawal(
    rows.map((row) => Number(row.amount) || 0),
    amountMinor,
  );
  if (!coveredIndexes.length) return { withdrawn: 0 };

  const result = await TutorEarning.updateMany(
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
 * and the tutor could never withdraw that money a second time.
 *
 * Keyed on `withdrawnByRef`, which is why the withdrawal reference is recorded on
 * the row rather than inferred — a later withdrawal of the same size must not have
 * its rows mistaken for this one's.
 */
async function restoreEarningsForWithdrawal(withdrawalRef) {
  if (!withdrawalRef) return { restored: 0 };

  const result = await TutorEarning.updateMany(
    { withdrawnByRef: withdrawalRef, status: 'withdrawn' },
    { $set: { status: 'available' }, $unset: { withdrawnAt: 1, withdrawnByRef: 1 } },
  );

  return { restored: result.modifiedCount || 0 };
}

/**
 * Reverses an earning that has already been recorded.
 *
 * Nothing is ever deleted — the financial record has to survive — so a reversal
 * writes a *compensating* pair: a negative earning row and a debit ledger row.
 * Summing the collection therefore still yields the true net earned.
 *
 * If the earnings were already withdrawn the balance is allowed to go negative and
 * is offset by the tutor's next earning. Clamping to zero would quietly forgive a
 * debt the platform is actually owed.
 *
 * There is no automated caller: no refund or chargeback path exists in the backend
 * today, so this is ready for an admin surface (or a future refund flow) to call.
 * It is not a guarantee that refunds are handled.
 */
async function reverseEarning(earningRef, { reason, actor } = {}) {
  if (!earningRef) throw new Error('An earning reference is required');
  if (!reason || !String(reason).trim()) throw new Error('A reason is required to reverse an earning');

  const original = await TutorEarning.findOne({ earningRef });
  if (!original) throw new Error('Earning not found');
  if (original.amount < 0) throw new Error('This row is already a reversal');
  if (original.reversalRef) throw new Error('This earning has already been reversed');

  const reversalRef = `tutor-reversal-${earningRef}`;

  const reversal = await TutorEarning.create({
    tutorId: original.tutorId,
    studentId: original.studentId,
    courseId: original.courseId,
    providerId: original.providerId,
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
    reverses: earningRef,
    rateSource: original.rateSource,
    earningRef: reversalRef,
    currency: original.currency,
  });

  original.status = 'reversed';
  original.reversedAt = new Date();
  original.reversalReason = String(reason).trim();
  original.reversalRef = reversalRef;
  original.reversedBy = actor || undefined;
  await original.save();

  // Money only moves if it had already reached the balance. An earning still inside
  // its holding period has never been credited, so reversing it is purely a
  // bookkeeping change — debiting the wallet would take money that was never there.
  const wasReleased = Boolean(original.releasedAt);

  if (wasReleased) {
    const amountMajor = toMajor(original.amount);
    const tutor = await User.findById(original.tutorId).select('balance');
    const balanceAfter = (Number(tutor?.balance) || 0) - amountMajor;

    try {
      await Transaction.create({
        userId: original.tutorId,
        courseId: original.courseId,
        amount: amountMajor,
        type: 'tutor_earning_reversal',
        direction: 'debit',
        balanceAfter,
        status: 'successful',
        txRef: `tutor-reversal-ledger-${earningRef}`,
        metadata: { reverses: earningRef, reason: String(reason).trim(), reversedBy: actor ? String(actor) : null },
      });
    } catch (error) {
      if (error?.code === 11000) return { reversal, debited: false, reason: 'already_reversed' };
      throw error;
    }

    await User.findByIdAndUpdate(original.tutorId, { $inc: { balance: -amountMajor } });

    Notification.create({
      title: 'Earning reversed',
      content: `An earning of ${formatMoney(amountMajor)} was reversed. Reason: ${String(reason).trim()}`,
      contentId: String(original.courseId),
      read: false,
      userId: original.tutorId,
    }).catch((error) => console.error('Tutor earning reversal notification failed:', error.message));

    return { reversal, debited: true };
  }

  return { reversal, debited: false };
}

module.exports = {
  generateTutorEarningsForPayment,
  accruedTutorShareForStudentCourse,
  releaseMaturedEarnings,
  reverseEarning,
  applyWithdrawalToEarnings,
  restoreEarningsForWithdrawal,
  earningRefFor,
  toMinor,
  toMajor,
  DEFAULT_HOLD_DAYS,
};
