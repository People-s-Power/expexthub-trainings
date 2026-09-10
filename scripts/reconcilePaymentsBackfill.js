/**
 * One-off backfill: drain the backlog of course payments and wallet fundings
 * that succeeded at Flutterwave but were never finalized locally — the payments
 * stranded while the webhook endpoint was down (and any where the student closed
 * the tab before the redirect verify ran).
 *
 * This is the manual, run-once counterpart to the scheduled sweep in
 * utils/paymentReconciler.js. It reuses the exact same candidate query and the
 * exact same per-row settlement (services/coursePaymentReconciler.js), so a row
 * is confirmed against the gateway and routed to the same idempotent finalizers
 * the webhook and redirect use. Running it can never double-credit: a finalized
 * payment is already `successful`, the instructor credit is unique-keyed, and a
 * wallet credit is gated on the still-pending status.
 *
 * Unlike the cron, this captures the working set once and processes each row a
 * single time, so it terminates deterministically even though a genuinely
 * in-flight charge would otherwise re-match the (throttle-disabled) filter on
 * every pass. Re-run it to pick up anything left pending or newly arrived.
 *
 *   node scripts/reconcilePaymentsBackfill.js --dry-run   # read-only: verify + report, writes nothing
 *   node scripts/reconcilePaymentsBackfill.js             # live: finalize confirmed charges
 */

require('dotenv/config');
const mongoose = require('mongoose');
const {
  findReconcileCandidates,
  reconcileOne,
} = require('../services/coursePaymentReconciler.js');
const { verifyCharge, isChargeConfirmed } = require('../services/flutterwaveGateway.js');

const DRY_RUN = process.argv.includes('--dry-run');

// Look back further than the cron's 21-day window so a run can clear an older
// backlog if one has accumulated; olderThanMs/recheckAfterMs are zeroed so every
// unresolved row is eligible right now regardless of the live throttle.
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
// A generous ceiling on rows examined per run. If a run hits it there may be
// more — re-run to continue. Kept finite so one run holds a bounded working set.
const BACKFILL_LIMIT = 5000;

/**
 * Read-only mirror of reconcileOne's decision tree, for --dry-run. Verifies the
 * charge and returns the label of the action a live run WOULD take, writing
 * nothing (no throttle stamp, no flag, no finalize).
 */
async function describeIntent(transaction) {
  const { ok, payment, notFound } = await verifyCharge({
    gatewayTransactionId: transaction.gatewayTransactionId || null,
    txRef: transaction.txRef,
  });

  if (notFound) {
    return transaction.status === 'failed'
      ? 'would resolve (abandoned — not registered at gateway)'
      : 'still pending (not yet registered at gateway)';
  }
  if (ok && isChargeConfirmed(payment, transaction)) {
    return `WOULD FINALIZE (${transaction.type})`;
  }
  if (payment && payment.status === 'successful') {
    return 'would FLAG for review (gateway success but amount/currency/ref mismatch)';
  }
  if (payment && (payment.status === 'failed' || payment.status === 'cancelled')) {
    return transaction.status === 'pending'
      ? 'would mark failed'
      : 'would resolve (already failed locally)';
  }
  return 'still pending (processing at gateway)';
}

async function main() {
  const { DB_USERNAME, DB_PASSWORD } = process.env;
  if (!DB_USERNAME || !DB_PASSWORD) {
    throw new Error('DB_USERNAME and DB_PASSWORD must be set to run this backfill');
  }
  if (!process.env.FLUTTERWAVE_SECRET) {
    throw new Error('FLUTTERWAVE_SECRET must be set — the backfill verifies each charge against the gateway');
  }

  await mongoose.connect(
    `mongodb+srv://${DB_USERNAME}:${DB_PASSWORD}@theplaint.u7pbgty.mongodb.net/?retryWrites=true&w=majority`,
  );
  console.log(`Connected.${DRY_RUN ? ' DRY RUN — nothing will be written.' : ''}`);

  const candidates = await findReconcileCandidates({
    olderThanMs: 0,
    recheckAfterMs: 0,
    maxAgeMs: MAX_AGE_MS,
    limit: BACKFILL_LIMIT,
  });
  console.log(`${candidates.length} candidate transaction(s) to check.`);
  if (candidates.length === BACKFILL_LIMIT) {
    console.log(`Hit the ${BACKFILL_LIMIT}-row ceiling — there may be more. Re-run after this pass.`);
  }

  const tally = { checked: 0, finalized: 0, failed: 0, flagged: 0, resolved: 0, pending: 0, errors: 0 };
  for (const transaction of candidates) {
    tally.checked += 1;
    const label = `${transaction.type} ${transaction.txRef}`;
    try {
      if (DRY_RUN) {
        const intent = await describeIntent(transaction);
        console.log(`  [dry-run] ${label}: ${intent}`);
      } else {
        const outcome = await reconcileOne(transaction);
        if (tally[outcome] !== undefined) tally[outcome] += 1;
        console.log(`  ${label}: ${outcome}`);
      }
    } catch (error) {
      tally.errors += 1;
      console.error(`  ${label}: ERROR —`, error.response?.data || error.message);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete. Checked ${tally.checked} transaction(s). Nothing written.`);
  } else {
    console.log(
      `\nBackfill complete. Checked ${tally.checked}: finalized ${tally.finalized}, `
      + `failed ${tally.failed}, flagged ${tally.flagged}, resolved ${tally.resolved}, `
      + `still pending ${tally.pending}, errors ${tally.errors}.`,
    );
  }
}

main()
  .catch(error => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
