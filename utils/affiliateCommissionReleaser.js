const cron = require('node-cron');
const { releaseMaturedCommissions } = require('../services/affiliateCommissionService.js');

/**
 * Releases affiliate commissions whose holding period has elapsed.
 *
 * The holding period exists so that a payment which later fails, is refunded or
 * is charged back cannot leave the affiliate holding money the platform has to
 * claw back. Earnings sit as `pending` until `holdUntil` passes, and this sweep is
 * what moves them into the affiliate's withdrawable balance.
 *
 * A sweep rather than an on-read release, because a commission matures on its own
 * clock: whether the affiliate ever opens the portal must not decide whether they
 * get paid. Running it repeatedly is safe — each row is claimed with a conditional
 * status transition, so overlapping sweeps and multiple instances cannot
 * double-credit.
 */
function startAffiliateCommissionRelease() {
  // Every 10 minutes, offset off both the withdrawal sweep (:00, :10, …) and the
  // payment sweep (:05, :15, …). This one touches no external gateway, but keeping
  // the three apart leaves each job's timing readable in the logs.
  cron.schedule('2-59/10 * * * *', async () => {
    try {
      const result = await releaseMaturedCommissions();
      // Only speak up when something actually happened, so a quiet log stays a
      // meaningful signal rather than a heartbeat to be ignored.
      if (result.released || result.skipped) {
        console.log(
          `Affiliate commission release: ${result.released} released, ${result.skipped} skipped of ${result.scanned} due`
        );
      }
    } catch (error) {
      console.error('Affiliate commission release sweep failed:', error);
    }
  });
}

module.exports = { startAffiliateCommissionRelease };
