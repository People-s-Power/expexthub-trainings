/**
 * The plan catalogue, server-side.
 *
 * `User.premiumPlan` stores the plan name lowercased. Until now that name came
 * from the request body of POST /user/premium, so a caller could pay for
 * Standard and post `plan: "enterprise"` to be activated on the top tier. The
 * name is now derived from the Flutterwave plan id carried on the *verified*
 * transaction — the one field the caller cannot choose — and this map is the
 * translation from that id to the tier.
 *
 * The ids are the ones the pricing table on /tutor/plans sends as
 * `payment_plan`. This list and that table have to stay in step: an id the
 * table offers but this map does not know is refused at activation rather than
 * activated on a guessed tier.
 */

const DEFAULT_PLAN_IDS = {
  133951: 'standard',   // monthly
  133952: 'standard',   // yearly
  133953: 'enterprise', // monthly
  133954: 'enterprise', // yearly
};

/**
 * The plan ids in force, with any configured additions merged over the
 * built-in ones. `FLUTTERWAVE_PLAN_IDS` is a JSON object of id to tier, for
 * adding a tier without a deploy:
 *
 *   FLUTTERWAVE_PLAN_IDS={"133955":"enterprise"}
 *
 * A malformed value is logged and ignored — refusing to activate every
 * subscription because of a typo in an unrelated env var would be worse than
 * running on the built-in list.
 */
function planIdMap() {
  const configured = process.env.FLUTTERWAVE_PLAN_IDS;
  if (!configured) return DEFAULT_PLAN_IDS;

  try {
    const parsed = JSON.parse(configured);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object of planId to tier');
    }
    return { ...DEFAULT_PLAN_IDS, ...parsed };
  } catch (error) {
    console.error('FLUTTERWAVE_PLAN_IDS is not usable; falling back to the built-in plan ids:', error.message);
    return DEFAULT_PLAN_IDS;
  }
}

/**
 * The tier a Flutterwave plan id belongs to, or null when the id is not one of
 * ours. Null is deliberately distinct from a default: an unknown id means we
 * cannot say what was bought, so activation is refused rather than guessed.
 */
function planNameForId(planId) {
  if (planId == null) return null;

  const name = planIdMap()[String(planId)];
  return typeof name === 'string' && name ? name.toLowerCase() : null;
}

/**
 * Which tiers carry the paid features.
 *
 * This mirrors the pricing table on /tutor/plans and the frontend's
 * `src/utils/premium.ts` — Basic has no email tools, Standard and Enterprise
 * both do. Change one and the other has to change with it.
 */
const PAID_PLANS = ['standard', 'enterprise'];

function hasPaidPlan(plan) {
  return typeof plan === 'string' && PAID_PLANS.includes(plan.toLowerCase());
}

module.exports = { DEFAULT_PLAN_IDS, PAID_PLANS, hasPaidPlan, planNameForId };
