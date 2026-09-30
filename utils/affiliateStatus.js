/**
 * The affiliate lifecycle, in one place.
 *
 * Affiliates used to be approved by hand, so five different places asked "is this
 * affiliate allowed to earn?" by comparing the status to `'approved'`. Approval
 * has since been removed — every signup is live immediately — but documents
 * written under the old model are still out there holding the old words, and
 * `scripts/migrateAffiliateStatus.js` only folds them over when someone runs it.
 *
 * That ordering matters: code deploys before a migration runs, always. If every
 * gate compared to `'active'` directly, then in the window between the two, an
 * affiliate who had been legitimately approved under the old model would silently
 * stop earning commission — the exact failure that is hardest to notice and
 * hardest to explain afterwards. So the legacy words are understood here, and the
 * migration becomes an ordinary tidy-up rather than a step the deploy depends on.
 *
 * The two legacy families map by what they *meant*, not by how they were spelled:
 *
 *   - `pending`, `under_review`, `approved` all meant "not switched off", and the
 *     first two only existed to wait for an approval that no longer happens, so
 *     all three mean active.
 *   - `rejected`, `suspended` both meant "switched off", so both mean deactivated.
 */

/** Standing that permits referring and earning. */
const ACTIVE_STATUSES = ['active', 'pending', 'under_review', 'approved'];

/** Standing that does not. */
const DEACTIVATED_STATUSES = ['deactivated', 'rejected', 'suspended'];

/**
 * The status an administrator should be shown for an affiliate, normalised to the
 * two words the console speaks.
 *
 * Anything unrecognised — including an absent profile, which is how an affiliate
 * record written before the field existed reads — resolves to active, matching the
 * schema default. Defaulting the other way would strand a real affiliate behind a
 * gate they cannot see or clear.
 */
function affiliateStatus(affiliate) {
  const raw = String(affiliate?.affiliateProfile?.status || '').trim();
  if (DEACTIVATED_STATUSES.includes(raw)) return 'deactivated';
  return 'active';
}

/** Whether this affiliate may currently refer students and earn commission. */
function isAffiliateActive(affiliate) {
  return affiliateStatus(affiliate) === 'active';
}

/**
 * A Mongo filter selecting only affiliates who may earn.
 *
 * Exported as a fragment rather than a predicate because the directory and the
 * referral lookup both need to filter inside the query — they select on fields
 * they never load into memory, so there is nothing to hand a function.
 */
const ACTIVE_AFFILIATE_FILTER = { 'affiliateProfile.status': { $in: ACTIVE_STATUSES } };

module.exports = {
  ACTIVE_STATUSES,
  DEACTIVATED_STATUSES,
  ACTIVE_AFFILIATE_FILTER,
  affiliateStatus,
  isAffiliateActive,
};
