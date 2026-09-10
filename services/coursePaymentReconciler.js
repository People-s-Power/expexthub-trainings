// Safety net for course payments and wallet fundings whose confirmation never
// arrived — a missed webhook (endpoint downtime, a dropped delivery) or a student
// who closed the tab before the redirect verify ran. This is the course-payment
// twin of withdrawalService's reconcilePendingWithdrawals: the money logic lives
// here so the cron (utils/paymentReconciler.js) and the one-off backfill script
// both reuse it without importing an HTTP controller.
//
// Every finalizer this calls is idempotent — guarded status transitions plus a
// unique instructor-credit ref — so overlapping with a late webhook or redirect
// can never double-credit. The sweep only READS the gateway and routes a
// confirmed charge to those finalizers; it never invents money.
const Transaction = require('../models/transactions.js');
const { verifyCharge, isChargeConfirmed } = require('./flutterwaveGateway.js');
const { finalizeFullCoursePayment, finalizeInstallmentPayment } = require('./coursePaymentService.js');
const { finalizeWalletFunding } = require('./walletFundingService.js');

// A payment may sit unconfirmed this long before the sweep actively checks it —
// comfortably longer than a normal charge + webhook round-trip, so only genuinely
// stuck rows are ever touched.
const RECONCILE_AFTER_MS = 15 * 60 * 1000;
// Once checked and still unresolved, a row is left alone this long before being
// rechecked, so the sweep does not hammer the gateway for the same slow charge on
// every run.
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;
// A charge older than this is past every gateway retry and settlement window; a
// row still unconfirmed by then is abandoned, not in flight, so stop sweeping it.
const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 100;

// The money-in transaction types this sweep settles. Full course payments and
// wallet fundings are only ever swept while `pending`; a `failed`
// `course_installment` is also swept, because an abandoned checkout is flipped to
// `failed` locally (releaseStalePayments) even though the gateway may still settle
// it out of band — and finalizeInstallmentPayment credits it by payment number
// regardless of the local status.
const RECONCILABLE_TYPES = ['course_payment', 'course_installment', 'wallet_funding'];

/**
 * Builds the candidate query and returns the stuck transactions, oldest first.
 *
 * Shared by the live sweep and the backfill script's --dry-run so both reason
 * about exactly the same working set.
 */
function findReconcileCandidates({
  olderThanMs = RECONCILE_AFTER_MS,
  recheckAfterMs = RECHECK_INTERVAL_MS,
  maxAgeMs = MAX_AGE_MS,
  limit = BATCH_LIMIT,
} = {}) {
  const now = Date.now();
  const olderThan = new Date(now - olderThanMs);
  const floor = new Date(now - maxAgeMs);
  const recheckBefore = new Date(now - recheckAfterMs);

  return Transaction.find({
    type: { $in: RECONCILABLE_TYPES },
    date: { $gte: floor, $lte: olderThan },
    // A prior sweep flagged an anomaly (see below) or settled this as terminally
    // dead — either way a human decides its fate, so stop auto-sweeping it.
    'metadata.reconcileNeedsReview': { $ne: true },
    'metadata.reconcileResolved': { $ne: true },
    $and: [
      {
        // Throttle: never checked, or last checked long enough ago to try again.
        $or: [
          { 'metadata.reconcileCheckedAt': { $exists: false } },
          { 'metadata.reconcileCheckedAt': { $lte: recheckBefore } },
        ],
      },
      {
        $or: [
          { status: 'pending' },
          { status: 'failed', type: 'course_installment' },
        ],
      },
    ],
  })
    .sort({ date: 1 })
    .limit(limit);
}

/**
 * Confirms one stuck transaction against the gateway and routes a confirmed
 * charge to the right finalizer.
 *
 * Returns 'finalized' | 'failed' | 'flagged' | 'pending' | 'resolved'.
 * Every row is stamped with metadata.reconcileCheckedAt (a dot-path $set that
 * leaves sibling metadata intact) so the recheck throttle can see it.
 */
async function reconcileOne(transaction) {
  const { ok, payment, notFound } = await verifyCharge({
    gatewayTransactionId: transaction.gatewayTransactionId || null,
    txRef: transaction.txRef,
  });

  const stamp = (extra = {}) => Transaction.updateOne(
    { _id: transaction._id },
    { $set: { 'metadata.reconcileCheckedAt': new Date(), ...extra } },
  );

  // Not registered at the gateway.
  if (notFound) {
    if (transaction.status === 'failed') {
      // Already failed locally and the gateway has no charge either: genuinely
      // abandoned. Mark it resolved so the sweep converges instead of re-polling
      // a dead row for the rest of the max-age window.
      await stamp({ 'metadata.reconcileResolved': true });
      return 'resolved';
    }
    // A pending charge the gateway has not registered yet: still in flight.
    await stamp();
    return 'pending';
  }

  if (ok && isChargeConfirmed(payment, transaction)) {
    // Idempotent finalizers: route by type. A finalized row becomes `successful`
    // and so drops out of the candidate query on its own.
    if (transaction.type === 'wallet_funding') {
      await finalizeWalletFunding(transaction.txRef, payment);
    } else if (transaction.type === 'course_installment') {
      await finalizeInstallmentPayment(transaction, payment);
    } else {
      await finalizeFullCoursePayment(transaction, payment);
    }
    await stamp();
    return 'finalized';
  }

  // Gateway says the charge is done but it does NOT match what we recorded (wrong
  // amount, currency, or reference). Never credit on a mismatch — flag it for a
  // human and stop auto-sweeping it.
  if (payment && payment.status === 'successful') {
    await stamp({ 'metadata.reconcileNeedsReview': true });
    return 'flagged';
  }

  // Gateway reports a terminal failure. Fail a still-pending row (mirrors the
  // webhook/redirect behaviour: frees a plan's slot for a fresh charge) and mark
  // it resolved so it is not swept again.
  if (payment && (payment.status === 'failed' || payment.status === 'cancelled')) {
    const wasPending = transaction.status === 'pending';
    if (wasPending) {
      await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
    }
    await stamp({ 'metadata.reconcileResolved': true });
    return wasPending ? 'failed' : 'resolved';
  }

  // Anything else (still processing at the gateway): leave it, recheck later.
  await stamp();
  return 'pending';
}

/**
 * Sweeps course payments and wallet fundings stuck unconfirmed and settles each
 * against the gateway. Safe to overlap a late webhook/redirect (idempotent
 * finalizers). One bad row never aborts the sweep — each is isolated in try/catch.
 *
 * Returns a tally { checked, finalized, failed, flagged, resolved }.
 */
async function reconcilePendingCoursePayments(options = {}) {
  const candidates = await findReconcileCandidates(options);

  const tally = { checked: 0, finalized: 0, failed: 0, flagged: 0, resolved: 0 };
  for (const transaction of candidates) {
    tally.checked += 1;
    try {
      const outcome = await reconcileOne(transaction);
      if (tally[outcome] !== undefined && outcome !== 'checked') tally[outcome] += 1;
    } catch (error) {
      console.error('Payment reconciliation failed for', transaction.txRef, '-', error.response?.data || error.message);
    }
  }

  if (tally.checked) {
    console.log(
      `Payment reconciliation: checked ${tally.checked}, finalized ${tally.finalized}, `
      + `failed ${tally.failed}, flagged ${tally.flagged}, resolved ${tally.resolved}.`,
    );
  }
  return tally;
}

module.exports = {
  RECONCILE_AFTER_MS,
  RECHECK_INTERVAL_MS,
  MAX_AGE_MS,
  BATCH_LIMIT,
  RECONCILABLE_TYPES,
  findReconcileCandidates,
  reconcileOne,
  reconcilePendingCoursePayments,
};
