const cron = require('node-cron');
const { releaseMaturedEarnings } = require('../services/tutorEarningService.js');

/**
 * Releases tutor earnings whose holding period has elapsed.
 *
 * The holding period exists so that a payment which later fails, is refunded or is
 * charged back cannot leave a tutor holding money the platform has to claw back.
 * Earnings sit as `pending` until `holdUntil` passes, and this sweep is what moves
 * them into the tutor's withdrawable balance — the same lifecycle an affiliate
 * commission has, and deliberately the same shape of job.
 *
 * A sweep rather than an on-read release, because an earning matures on its own
 * clock: whether the tutor ever opens the portal must not decide whether they get
 * paid. Running it repeatedly is safe — each row is claimed with a conditional
 * status transition, so overlapping sweeps and multiple instances cannot
 * double-credit.
 */
function startTutorEarningRelease() {
  // Every 10 minutes, in a third slot of its own: the withdrawal sweep owns :00,
  // the payment sweep :05, and the affiliate release :02. Nothing here talks to an
  // external gateway, but keeping the four apart leaves each job's timing readable
  // in the logs rather than interleaved with another's.
  cron.schedule('4-59/10 * * * *', async () => {
    try {
      const result = await releaseMaturedEarnings();
      // Only speak up when something actually happened, so a quiet log stays a
      // meaningful signal rather than a heartbeat to be ignored.
      if (result.released || result.skipped) {
        console.log(
          `Tutor earning release: ${result.released} released, ${result.skipped} skipped of ${result.scanned} due`
        );
      }
    } catch (error) {
      console.error('Tutor earning release sweep failed:', error);
    }
  });
}

module.exports = { startTutorEarningRelease };
