/**
 * Which percentage a provider pays their tutors on a given course.
 *
 * The same two-tier shape as the affiliate commission, resolved in the same
 * order, because a provider reading either settings screen should be able to
 * reason about them the same way:
 *
 *   1. the provider's master switch — off means nothing is paid, for any course
 *   2. the course's own rate, when it has one
 *   3. the provider's general rate
 *
 * The master switch outranks the per-course rate deliberately, mirroring
 * `affiliateSettings.enabled` in services/affiliateCommissionService.js. A
 * per-course rate is an adjustment *within* a provider's programme, not a
 * separate arrangement, so turning the programme off has to stop every course —
 * otherwise a rate set months ago on one course keeps paying silently after the
 * provider believes they have stopped paying tutors at all.
 *
 * Deliberately pure and database-free: this is the money rule, and it is worth
 * being able to check every arm of it without a connection.
 * `scripts/tutorShareResolution.check.js` does exactly that.
 */

const { clampPercentage } = require('../utils/revenueShare.js');

/** A course tier is "set" when it carries a number. `null` means "inherit". */
function hasCourseRate(courseTutorShare) {
  if (!courseTutorShare) return false;
  const value = courseTutorShare.value;
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

/**
 * The effective percentage, 0 meaning "no share is paid".
 *
 * `courseTutorShare` is `Course.tutorShare` and `revenueShare` is
 * `User.tutorRevenueShare` — both may be absent, which is the state of every
 * document written before this existed, and resolves to the pre-existing
 * behaviour exactly.
 */
function resolveTutorSharePercent({ courseTutorShare = null, revenueShare = null } = {}) {
  // The master switch. `enabled` defaults to false, so an account that never
  // opted in pays nothing however its courses are configured.
  if (!revenueShare?.enabled) return 0;

  if (courseTutorShare) {
    // A deliberate opt-out for this one course, even though the programme is on.
    if (courseTutorShare.enabled === false) return 0;

    // The course's own rate decides on its own once it is set — including when
    // it is 0. Falling back to the general rate for a course the provider has
    // explicitly set to zero would pay a share they have already declined.
    if (hasCourseRate(courseTutorShare)) {
      return clampPercentage(courseTutorShare.value);
    }
  }

  return clampPercentage(revenueShare.percentage);
}

module.exports = {
  resolveTutorSharePercent,
  hasCourseRate,
};
