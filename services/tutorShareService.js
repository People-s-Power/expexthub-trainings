/**
 * What a provider pays their tutors on a given course.
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
 * A tier is a *rate*, not a bare number: `{ type, value }`, where `type` is
 * `percentage` (a proportion of what the student pays) or `fixed` (a flat fee for
 * the course, divided between whoever is assigned). Returning the pair together
 * is what stops the split applying one and the ledger recording the other.
 *
 * Deliberately pure and database-free: this is the money rule, and it is worth
 * being able to check every arm of it without a connection.
 * `scripts/tutorShareResolution.check.js` does exactly that.
 */

const { clampPercentage } = require('../utils/revenueShare.js');

/** `fixed` is the only other type; anything unrecognised is treated as a percentage. */
const rateTypeOf = (value) => (value === 'fixed' ? 'fixed' : 'percentage');

/**
 * A percentage is bounded by the platform's ceiling. A fixed fee is not a
 * proportion of anything, so the ceiling does not apply to it — the split clamps
 * the pool to the provider's net instead. Unusable values resolve to 0, which
 * reads as "no share", rather than to NaN, which would write a ledger row with no
 * amount.
 */
function clampShare(type, value) {
  if (type === 'fixed') {
    const fee = Number(value);
    return Number.isFinite(fee) && fee > 0 ? fee : 0;
  }
  return clampPercentage(value);
}

/** A course tier is "set" when it carries a number. `null` means "inherit". */
function hasCourseRate(courseTutorShare) {
  if (!courseTutorShare) return false;
  const value = courseTutorShare.value;
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

/**
 * The effective percentage, 0 meaning "no share is paid".
 *
 * Kept for the callers that only want the number — the assign-tutor preview and
 * the resolution checks. A fixed rate resolves to its naira value here, which is
 * meaningless as a percentage, so anything that can face a fixed rate should read
 * `resolveTutorShare` instead and branch on `type`.
 */
function resolveTutorSharePercent(options = {}) {
  return resolveTutorShare(options).value;
}

/**
 * The effective rate, reporting which tier supplied it.
 *
 * The tier is reported because the earning ledger records it alongside the amount
 * — the `rateSource` column on `TutorEarning` — so support can answer "why did
 * this pay 50%?" without re-deriving the settings as they were on the day.
 * Returning it from the one resolution rather than re-deciding it at the write
 * site is what stops the recorded reason drifting from the recorded number.
 *
 * `source` is `null` whenever the answer is 0: neither the master switch being off
 * nor a course opt-out is a tier that supplied a rate, and calling either of them
 * `course_override` would put a reason on a row that was never written.
 *
 * `courseTutorShare` is `Course.tutorShare` and `revenueShare` is
 * `User.tutorRevenueShare` — both may be absent, which is the state of every
 * document written before this existed, and resolves to the pre-existing
 * behaviour exactly.
 */
function resolveTutorShare({ courseTutorShare = null, revenueShare = null } = {}) {
  // The master switch. `enabled` defaults to false, so an account that never
  // opted in pays nothing however its courses are configured.
  if (!revenueShare?.enabled) return { type: null, value: 0, source: null };

  if (courseTutorShare) {
    // A deliberate opt-out for this one course, even though the programme is on.
    if (courseTutorShare.enabled === false) return { type: null, value: 0, source: null };

    // The course's own rate decides on its own once it is set — including when
    // it is 0. Falling back to the general rate for a course the provider has
    // explicitly set to zero would pay a share they have already declined.
    //
    // Note this is looser than the affiliate's course override, which also needs
    // `enabled === true` and a non-zero value to fire. Kept deliberately: the
    // per-course editor's own helper text promises that 0 on a course stops that
    // course's share while the rest of the programme stays on, and a tier that
    // silently falls through on 0 would break that promise. Checked by
    // scripts/tutorShareResolution.check.js.
    if (hasCourseRate(courseTutorShare)) {
      const type = rateTypeOf(courseTutorShare.type);
      return { type, value: clampShare(type, courseTutorShare.value), source: 'course_override' };
    }
  }

  const type = rateTypeOf(revenueShare.type);
  return { type, value: clampShare(type, revenueShare.value), source: 'provider' };
}

module.exports = {
  resolveTutorShare,
  resolveTutorSharePercent,
  hasCourseRate,
};
