// Check the premium plan catalogue — what /tutor/plans offers and what activation
// recognises, which have to be the same list.
//
// That sameness is the point of this file. The ids used to be kept by hand in two
// places, and when they drifted the checkout opened on a plan Flutterwave refused
// with "Payment plan does not exist" — a failure the page could not explain and
// nothing logged. So the assertion that matters most is the round trip: every id
// we offer must map back to the tier offering it. The rest exercises the env
// override, whose whole job is to be editable under pressure during an incident.
//
//   node scripts/plans.check.js
//
// No database, no network, no server: this drives utils/plans.js on its own.
const plans = require('../utils/plans.js');

// Read the ids out of the catalogue rather than repeating them here. This file
// exists because a second copy of the ids drifted from the first; a third copy
// inside the check would be the same mistake with a shorter feedback loop.
const STANDARD = plans.DEFAULT_CATALOGUE.standard;
const ENTERPRISE = plans.DEFAULT_CATALOGUE.enterprise;

const ENV_VARS = ['FLUTTERWAVE_PLANS', 'FLUTTERWAVE_PLAN_IDS'];

let failed = 0;

function check(name, run) {
  try {
    const problems = run() || [];
    if (problems.length) {
      failed += 1;
      console.log(`FAIL ${name}: ${problems.join(', ')}`);
    } else {
      console.log(`ok   ${name}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/**
 * Runs `fn` with the given env vars set, capturing anything logged.
 *
 * The fallbacks below are only correct if they are *noisy*: silently ignoring a
 * typo in a hand-written override is how an operator ends up believing they
 * changed something they did not.
 */
function withEnv(env, fn) {
  const saved = {};
  for (const key of ENV_VARS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }

  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));

  try {
    return { result: fn(), logged };
  } finally {
    console.error = realError;
    for (const key of ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Every offering must be internally sound and map back to the tier that offered it. */
function problemsWith(offerings) {
  const problems = [];
  if (!offerings.length) problems.push('nothing is on sale');

  const seen = new Set();
  for (const { tier, interval, planId, amount, currency } of offerings) {
    const where = `${tier} ${interval}`;
    if (typeof planId !== 'number') problems.push(`${where}: planId is not a number`);
    if (!(amount > 0)) problems.push(`${where}: amount is not positive`);
    if (currency !== plans.CURRENCY) problems.push(`${where}: currency is ${currency}`);
    if (seen.has(planId)) problems.push(`${where}: plan id ${planId} is on sale twice`);
    seen.add(planId);

    const back = plans.planNameForId(planId);
    if (back !== tier) problems.push(`${where}: id ${planId} maps back to ${back}`);
    if (!plans.hasPaidPlan(tier)) problems.push(`${where}: ${tier} is on sale but not a paid tier`);
  }

  return problems;
}

/** Asserts an override is refused, logged, and leaves the built-in list in force. */
function problemsWhenRefused(value) {
  const { result: problems, logged } = withEnv({ FLUTTERWAVE_PLANS: value }, () => {
    const found = [];
    if (plans.planNameForId(STANDARD.monthly.id) !== 'standard') found.push('the built-in ids are no longer in force');
    if (plans.planCatalogue().length !== 4) found.push('the built-in catalogue is not what is on sale');
    return found;
  });
  if (!logged.length) problems.push('the bad override was ignored silently');
  return problems;
}

check('the built-in catalogue is sound and round-trips', () => problemsWith(plans.planCatalogue()));

// One direction only: everything on sale is paid. The reverse is not an error —
// a tier can be paid and off sale (the legacy override adds one, and an operator
// can take a tier off sale from env) — but a tier on sale that the gate does not
// recognise is the bug that once locked paying customers out of the features
// they had bought.
check('every tier on sale is a paid tier, and Basic is not', () => {
  const problems = [];
  if (plans.hasPaidPlan('basic')) problems.push('basic counts as paid');
  if (plans.hasPaidPlan(undefined)) problems.push('an unloaded profile counts as paid');
  if (plans.hasPaidPlan('')) problems.push('an empty plan counts as paid');
  return problems;
});

check('an unrecognised plan id is refused rather than guessed', () => {
  const problems = [];
  if (plans.planNameForId(999999) !== null) problems.push('an unknown id resolved to a tier');
  if (plans.planNameForId(undefined) !== null) problems.push('undefined resolved to a tier');
  if (plans.planNameForId(null) !== null) problems.push('null resolved to a tier');
  return problems;
});

check('FLUTTERWAVE_PLANS replaces a tier without a deploy', () => {
  const { result: problems, logged } = withEnv({
    FLUTTERWAVE_PLANS: JSON.stringify({ standard: { monthly: { id: 999001, amount: 8150 } } }),
  }, () => {
    const found = problemsWith(plans.planCatalogue());
    const offerings = plans.planCatalogue();
    const standard = offerings.filter(o => o.tier === 'standard');

    if (standard.length !== 1 || standard[0].interval !== 'monthly') {
      found.push('standard kept an interval the override dropped');
    }
    if (standard[0] && standard[0].amount !== 8150) found.push('the overridden amount is not in force');
    if (offerings.length !== 3) found.push(`expected 3 offerings, got ${offerings.length}`);
    if (plans.planNameForId(STANDARD.yearly.id) !== null) found.push('the replaced standard yearly id is still recognised');
    return found;
  });
  if (logged.length) problems.push('a valid override was refused');
  return problems;
});

check('a malformed override is refused, loudly', () => problemsWhenRefused('{oops'));
check('a non-object override is refused, loudly', () => problemsWhenRefused('[]'));
check('an unknown interval is refused, loudly', () => problemsWhenRefused(JSON.stringify({ standard: { weekly: { id: 1, amount: 10 } } })));
check('a tier with no intervals is refused, loudly', () => problemsWhenRefused(JSON.stringify({ standard: {} })));
check('a non-positive amount is refused, loudly', () => problemsWhenRefused(JSON.stringify({ standard: { monthly: { id: STANDARD.monthly.id, amount: 0 } } })));
check('a non-integer plan id is refused, loudly', () => problemsWhenRefused(JSON.stringify({ standard: { monthly: { id: String(STANDARD.monthly.id), amount: 8000 } } })));

// The collision this is really guarding: an override that reuses a built-in id,
// which would make the tier of a charge depend on iteration order.
check('an id already in the catalogue is refused, loudly', () => problemsWhenRefused(JSON.stringify({ standard: { monthly: { id: ENTERPRISE.monthly.id, amount: 8000 } } })));

check('two tiers claiming one id is refused, loudly', () => problemsWhenRefused(JSON.stringify({
  standard: { monthly: { id: 777001, amount: 8000 } },
  enterprise: { monthly: { id: 777001, amount: 15000 } },
})));

check('FLUTTERWAVE_PLAN_IDS adds an id activation recognises, and nothing on sale', () => {
  const { result: problems, logged } = withEnv({ FLUTTERWAVE_PLAN_IDS: JSON.stringify({ 133999: 'enterprise' }) }, () => {
    const found = problemsWith(plans.planCatalogue());
    if (plans.planNameForId(133999) !== 'enterprise') found.push('the extra id is not recognised at activation');
    if (plans.planCatalogue().some(o => o.planId === 133999)) found.push('an id with no amount was put on sale');
    return found;
  });
  if (logged.length) problems.push('the legacy override was refused');
  return problems;
});

check('a tier known only to the legacy override still counts as paid', () => {
  const { result: problems } = withEnv({ FLUTTERWAVE_PLAN_IDS: JSON.stringify({ 133999: 'pro' }) }, () => {
    const found = [];
    if (!plans.hasPaidPlan('pro')) found.push('an account on the legacy tier would lose the paid features');
    return found;
  });
  return problems;
});

check('a malformed FLUTTERWAVE_PLAN_IDS is refused, loudly', () => {
  const { result: problems, logged } = withEnv({ FLUTTERWAVE_PLAN_IDS: 'not json' }, () => {
    const found = [];
    if (plans.planNameForId(STANDARD.monthly.id) !== 'standard') found.push('the catalogue stopped working');
    return found;
  });
  if (!logged.length) problems.push('the bad legacy override was ignored silently');
  return problems;
});

console.log('');
console.log('On sale now:');
for (const { tier, interval, planId, amount, currency } of plans.planCatalogue()) {
  console.log(`  ${tier.padEnd(11)} ${interval.padEnd(8)} ${currency} ${String(amount).padStart(7)}  plan ${planId}`);
}
console.log('');
console.log('Every id these must exist in the Flutterwave account behind FLUTTERWAVE_PUBLIC_KEY and FLUTTERWAVE_SECRET.');
console.log('An id that does not is refused by the checkout with "Payment plan does not exist".');

process.exit(failed ? 1 : 0);
