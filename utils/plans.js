/**
 * The plan catalogue, server-side.
 *
 * This is the only list of premium plans. Each tier's Flutterwave plan id and
 * amount live here and reach the pricing table through GET /user/plans, rather
 * than being typed into the page as well. They used to be two hand-kept copies
 * of the same four ids; when those copies drifted, the checkout offered a plan
 * Flutterwave refused with "Payment plan does not exist" — an error the page
 * could not explain and nothing in the logs recorded.
 *
 * `User.premiumPlan` holds the tier name lowercased, taken at activation from
 * the plan id on the *verified* transaction — the one field the caller cannot
 * choose. An id therefore has to mean exactly one tier: two tiers claiming the
 * same id would make the tier depend on iteration order, so that is refused
 * rather than resolved.
 *
 * The ids must exist on the Flutterwave account behind FLUTTERWAVE_PUBLIC_KEY
 * and FLUTTERWAVE_SECRET, in the same mode. An id that does not is refused by
 * the checkout itself, before any of this code runs.
 */

const CURRENCY = 'NGN';

// The intervals a plan can be sold on. Also the order the catalogue is served
// in, so the pricing page needs no ordering of its own.
const INTERVALS = ['monthly', 'yearly'];

// tier -> interval -> { id, amount }
//
// The ids are the live plans on the Flutterwave account behind
// FLUTTERWAVE_PUBLIC_KEY and FLUTTERWAVE_SECRET. They are also the plans created
// in Test Mode on the same account, which have different ids — that is what
// FLUTTERWAVE_PLANS is for, and it is the only way to point an environment at
// the test ones.
//
// The amount is written here as well as on the plan because it is what the
// pricing page displays, while the plan's own amount is what Flutterwave renews
// at. Changing one on the dashboard without changing it here advertises a price
// the renewals will not honour.
const DEFAULT_CATALOGUE = {
  standard: {
    monthly: { id: 170261, amount: 8000 },
    yearly: { id: 170262, amount: 80000 },
  },
  enterprise: {
    monthly: { id: 170264, amount: 15000 },
    yearly: { id: 170265, amount: 150000 },
  },
};

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Checks a catalogue-shaped object before it is allowed to replace a tier.
 *
 * Throws with a message naming the tier and interval at fault, because this runs
 * on a hand-written env var and "the catalogue is invalid" is not a useful thing
 * to find in a log at 2am.
 *
 * Two things are refused outright rather than repaired:
 *
 * - a tier with no intervals. Emptying a tier is far more likely to be a typo
 *   than an intention, and the damage is asymmetric: tiers are also what
 *   `hasPaidPlan` reads, so a tier that vanishes from the catalogue takes the
 *   paid features away from the accounts already on it.
 * - one plan id under two tiers. See the note at the top of the file.
 */
function validateCatalogue(candidate, label) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('expected a JSON object of tier -> interval -> { id, amount }');
  }

  const owners = new Map();

  for (const [tier, byInterval] of Object.entries(candidate)) {
    if (!byInterval || typeof byInterval !== 'object' || Array.isArray(byInterval)) {
      throw new Error(`tier "${tier}" must be an object of interval -> { id, amount }`);
    }

    const intervals = Object.keys(byInterval);
    if (!intervals.length) {
      throw new Error(`tier "${tier}" lists no intervals; drop the tier from the override to leave it as it is`);
    }

    for (const interval of intervals) {
      const entry = byInterval[interval];
      const where = `tier "${tier}" ${interval}`;

      if (!INTERVALS.includes(interval)) {
        throw new Error(`${where}: unknown interval, expected one of ${INTERVALS.join(', ')}`);
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${where} must be an object of { id, amount }`);
      }
      if (!Number.isInteger(entry.id) || entry.id <= 0) {
        throw new Error(`${where} needs a positive integer plan id`);
      }
      if (!isPositiveNumber(entry.amount)) {
        throw new Error(`${where} needs a positive amount`);
      }

      const owner = owners.get(entry.id);
      if (owner && owner !== tier) {
        throw new Error(`plan id ${entry.id} is claimed by both "${owner}" and "${tier}"`);
      }
      owners.set(entry.id, tier);
    }
  }

  return candidate;
}

/**
 * The ids the older FLUTTERWAVE_PLAN_IDS knob adds to activation.
 *
 * Kept working for anyone already setting it, but it is deliberately not part of
 * the catalogue: it carries no amount or interval, so an id in it can be
 * recognised at activation and cannot be offered on the pricing page.
 */
function legacyIdOverrides() {
  const configured = process.env.FLUTTERWAVE_PLAN_IDS;
  if (!configured) return {};

  try {
    const parsed = JSON.parse(configured);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object of planId to tier');
    }
    return parsed;
  } catch (error) {
    console.error('FLUTTERWAVE_PLAN_IDS is not usable; ignoring it:', error.message);
    return {};
  }
}

/**
 * The catalogue in force: FLUTTERWAVE_PLANS merged over the built-in tiers, whole
 * tier by whole tier.
 *
 *   FLUTTERWAVE_PLANS={"standard":{"monthly":{"id":999001,"amount":8000}}}
 *
 * A tier named there replaces the built-in one entirely, including dropping the
 * intervals it does not list — which is what takes a plan off sale without a
 * deploy. The merged result is validated as a whole rather than the override on
 * its own, so an id that collides with a built-in one is caught too; a fault
 * anywhere in it is logged and the built-in list is used instead of a
 * half-applied one.
 */
function catalogue() {
  const configured = process.env.FLUTTERWAVE_PLANS;
  if (!configured) return DEFAULT_CATALOGUE;

  try {
    const parsed = JSON.parse(configured);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object of tier -> interval -> { id, amount }');
    }
    return validateCatalogue({ ...DEFAULT_CATALOGUE, ...parsed }, 'FLUTTERWAVE_PLANS');
  } catch (error) {
    console.error('FLUTTERWAVE_PLANS is not usable; falling back to the built-in plan catalogue:', error.message);
    return DEFAULT_CATALOGUE;
  }
}

/** Plan id -> tier, for reading a tier back off a verified charge. */
function planIdMap() {
  const map = {};

  for (const [tier, byInterval] of Object.entries(catalogue())) {
    for (const interval of INTERVALS) {
      const entry = byInterval[interval];
      if (entry) map[String(entry.id)] = tier;
    }
  }

  return { ...map, ...legacyIdOverrides() };
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
 * Derived from the catalogue rather than listed again, so a tier cannot be added
 * to the pricing page and left out of the gate — gating email on Enterprise
 * alone is what once locked out paying Standard customers. The legacy override
 * is included for the same reason: an account activated on an id only it knows
 * is on a paid tier too.
 *
 * The derivation is why a tier with no intervals is refused in validation: a
 * tier that leaves the catalogue is also, by this reading, no longer paid.
 */
function paidPlans() {
  const tiers = new Set(Object.keys(catalogue()));

  for (const tier of Object.values(legacyIdOverrides())) {
    if (typeof tier === 'string' && tier) tiers.add(tier.toLowerCase());
  }

  return [...tiers];
}

function hasPaidPlan(plan) {
  return typeof plan === 'string' && paidPlans().includes(plan.toLowerCase());
}

/**
 * The catalogue as the pricing page needs it: one row per plan on sale, in
 * catalogue order then interval order, carrying the commercial facts only.
 *
 * The page keeps its own marketing copy — descriptions, feature lists, which
 * tier is "most popular" — and merges it onto these rows by tier, so an
 * unoffered tier renders with its features and no way to pay for it rather than
 * a button that opens a checkout the gateway will refuse.
 */
function planCatalogue() {
  const offerings = [];

  for (const [tier, byInterval] of Object.entries(catalogue())) {
    for (const interval of INTERVALS) {
      const entry = byInterval[interval];
      if (!entry) continue;

      offerings.push({
        tier,
        interval,
        planId: entry.id,
        amount: entry.amount,
        currency: CURRENCY,
      });
    }
  }

  return offerings;
}

module.exports = {
  CURRENCY,
  INTERVALS,
  DEFAULT_CATALOGUE,
  catalogue,
  planCatalogue,
  planIdMap,
  planNameForId,
  paidPlans,
  hasPaidPlan,
};
