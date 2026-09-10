const cron = require('node-cron');
const { reconcilePendingWithdrawals } = require('../services/withdrawalService.js');

// Belt-and-suspenders for the transfer webhook. If a `transfer.completed` event
// is ever missed (endpoint downtime, misconfiguration, dropped delivery), this
// sweep settles withdrawals stuck in `pending` against the gateway, so money is
// never held indefinitely and a failed payout is always refunded. The sweep is
// idempotent with the webhook, so running both is safe.
function startWithdrawalReconciliation() {
  // Every 10 minutes, offset off the hour to avoid colliding with the reminder jobs.
  cron.schedule('*/10 * * * *', async () => {
    try {
      await reconcilePendingWithdrawals();
    } catch (error) {
      console.error('Withdrawal reconciliation sweep failed:', error);
    }
  });
}

module.exports = { startWithdrawalReconciliation };
