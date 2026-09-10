const cron = require('node-cron');
const { reconcilePendingCoursePayments } = require('../services/coursePaymentReconciler.js');

// Belt-and-suspenders for the Flutterwave charge webhook. If a payment
// confirmation is ever missed (endpoint downtime, misconfiguration, dropped
// delivery — or a student who closed the tab before the redirect verify ran),
// this sweep settles course payments and wallet fundings stuck unconfirmed by
// re-checking them against the gateway, so a paid course still records itself
// and the student is enrolled. The sweep is idempotent with the webhook and the
// redirect verifier, so running all three is safe.
function startPaymentReconciliation() {
  // Every 10 minutes, offset off the withdrawal sweep (which runs at :00, :10, …)
  // so the two do not hit the gateway in the same instant.
  cron.schedule('5-59/10 * * * *', async () => {
    try {
      await reconcilePendingCoursePayments();
    } catch (error) {
      console.error('Payment reconciliation sweep failed:', error);
    }
  });
}

module.exports = { startPaymentReconciliation };
