// Every arm of the two-tier tutor split: the general rate, the per-course
// override above it, the per-course opt-out, and the two ways the rate can be
// refused.
//
//   node scripts/tutorShareResolution.check.js
//
// No database and no network. `resolveTutorSharePercent` is pure and
// `splitCourseEarnings` is pure, which is the point of both: this is the rule
// that decides how much of a course payment leaves a provider's balance, and it
// is checkable without one.

const { resolveTutorSharePercent } = require('../services/tutorShareService.js');
const { splitCourseEarnings } = require('../services/coursePaymentService.js');

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

const eq = (name, actual, expected) =>
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

// The provider's general setting, on.
const general = (percentage) => ({ enabled: true, percentage });

console.log('--- resolution order ---\n');

eq(
  'a course with no tier pays the general rate',
  resolveTutorSharePercent({ courseTutorShare: null, revenueShare: general(20) }),
  20,
);
eq(
  "a course with the fields present but unset inherits too — this is what an untouched course looks like",
  resolveTutorSharePercent({
    courseTutorShare: { enabled: null, value: null },
    revenueShare: general(20),
  }),
  20,
);
eq(
  'a per-course rate overrides the general one',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, value: 30 },
    revenueShare: general(20),
  }),
  30,
);
eq(
  "a per-course rate applies even when `enabled` was not explicitly set — only `value` is required to mean 'set'",
  resolveTutorSharePercent({
    courseTutorShare: { enabled: null, value: 45 },
    revenueShare: general(20),
  }),
  45,
);

console.log('');
console.log('--- the opt-out ---\n');

eq(
  'an opted-out course pays nothing while the programme stays on',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: false, value: null },
    revenueShare: general(20),
  }),
  0,
);
// The sharp edge. `enabled: false` must beat the general rate, not fall through
// to it — otherwise the one control a provider has to stop paying on a single
// course silently does the opposite.
check(
  'the opt-out beats the general rate rather than falling through to it',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: false, value: null },
    revenueShare: general(20),
  }) !== 20,
  'it resolved to the general 20%',
);
eq(
  'a course explicitly set to zero pays nothing and does not fall back',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, value: 0 },
    revenueShare: general(20),
  }),
  0,
);

console.log('');
console.log('--- the master switch ---\n');

eq(
  'the programme off pays nothing',
  resolveTutorSharePercent({ courseTutorShare: null, revenueShare: { enabled: false, percentage: 20 } }),
  0,
);
// Same authority as affiliateSettings.enabled: a rate left on a course months ago
// must not keep paying after the provider believes they have stopped paying.
eq(
  'the programme off pays nothing even where a course carries its own rate',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, value: 30 },
    revenueShare: { enabled: false, percentage: 0 },
  }),
  0,
);
eq(
  'a provider who never opted in pays nothing',
  resolveTutorSharePercent({ courseTutorShare: null, revenueShare: {} }),
  0,
);
eq(
  'no settings at all pays nothing',
  resolveTutorSharePercent({}),
  0,
);

console.log('');
console.log('--- the ceiling ---\n');

const { MAX_SHARE_PERCENT, maxSharePercent } = require('../utils/revenueShare.js');
eq(
  'an over-ceiling per-course rate is clamped, not paid',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, value: MAX_SHARE_PERCENT + 40 },
    revenueShare: general(20),
  }),
  MAX_SHARE_PERCENT,
);
eq(
  'an over-ceiling general rate is clamped too',
  resolveTutorSharePercent({ courseTutorShare: null, revenueShare: general(MAX_SHARE_PERCENT + 40) }),
  MAX_SHARE_PERCENT,
);
eq(
  'a negative or unparseable rate is 0 rather than NaN',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, value: 'not a number' },
    revenueShare: general(20),
  }),
  20,
  );

console.log('');
console.log('--- the money, end to end ---\n');

const PROVIDER = 'a'.repeat(24);
const TUTOR_A = 'b'.repeat(24);
const TUTOR_B = 'c'.repeat(24);

// ₦10,000 gross, the platform's 5% fee, so the provider's net is ₦9,500.
const split = (courseTutorShare, revenueShare) =>
  splitCourseEarnings({
    amountMajor: 10000,
    instructorId: PROVIDER,
    assignedTutors: [TUTOR_A],
    revenueShare,
    courseTutorShare,
  });
const amountFor = (shares, id) =>
  shares.find((share) => String(share.userId) === String(id))?.amount;

const generalSplit = split(null, general(20));
eq('the provider receives the net minus the share', amountFor(generalSplit, PROVIDER), 7600);
eq('the tutor receives the general share of the net', amountFor(generalSplit, TUTOR_A), 1900);

const overrideSplit = split({ enabled: true, value: 30 }, general(20));
eq('the provider receives less where a course pays more', amountFor(overrideSplit, PROVIDER), 6650);
eq('the tutor receives the per-course rate, not the general one', amountFor(overrideSplit, TUTOR_A), 2850);

const optedOutSplit = split({ enabled: false, value: null }, general(20));
eq('an opted-out course leaves the whole net with the provider', amountFor(optedOutSplit, PROVIDER), 9500);
eq('and writes no tutor row at all', amountFor(optedOutSplit, TUTOR_A), undefined);
eq('so exactly one credit is written', optedOutSplit.length, 1);

// Two tutors divide one share; the parts must still sum to the net.
const twoTutorSplit = splitCourseEarnings({
  amountMajor: 10000,
  instructorId: PROVIDER,
  assignedTutors: [TUTOR_A, TUTOR_B],
  revenueShare: general(20),
  courseTutorShare: { enabled: true, value: 30 },
});
const total = twoTutorSplit.reduce((sum, share) => sum + share.amount, 0);
check(
  'the credits still sum to the net after rounding, with a per-course rate',
  Math.abs(total - 9500) < 0.005,
  `they summed to ${total}`,
);
eq(
  '20% to a course with two tutors is 15% each, not 20% each',
  amountFor(twoTutorSplit, TUTOR_B),
  1425,
);

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('the two-tier tutor split resolves and pays correctly');
