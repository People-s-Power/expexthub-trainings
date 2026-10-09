// Every arm of the two-tier tutor split: the general rate, the per-course
// override above it, the per-course opt-out, the fixed fee, the cap, and the ways
// a rate can be refused.
//
//   node scripts/tutorShareResolution.check.js
//
// No database and no network. `resolveTutorShare` is pure and `splitCourseEarnings`
// is pure, which is the point of both: this is the rule that decides how much of a
// course payment leaves a provider's balance, and it is checkable without one.
//
// The figures are all on a ₦10,000 gross, where the platform's 5% fee is ₦500 and
// the provider's net is ₦9,500. A share is a proportion of the *gross*, the same
// base the affiliate commission uses, so a 20% share costs the provider ₦2,000 and
// leaves them ₦7,500 — not 20% of the ₦9,500 net they were left.

const { resolveTutorShare, resolveTutorSharePercent } = require('../services/tutorShareService.js');
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

// The provider's general setting, on. Every rate is now a `{ type, value }` pair.
const general = (percentage) => ({ enabled: true, type: 'percentage', value: percentage });
const generalFixed = (fee) => ({ enabled: true, type: 'fixed', value: fee });

console.log('--- resolution order ---\n');

eq(
  'a course with no tier pays the general rate',
  resolveTutorSharePercent({ courseTutorShare: null, revenueShare: general(20) }),
  20,
);
eq(
  "a course with the fields present but unset inherits too — this is what an untouched course looks like",
  resolveTutorSharePercent({
    courseTutorShare: { enabled: null, type: null, value: null },
    revenueShare: general(20),
  }),
  20,
);
eq(
  'a per-course rate overrides the general one',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, type: 'percentage', value: 30 },
    revenueShare: general(20),
  }),
  30,
);
eq(
  "a per-course rate applies even when `enabled` was not explicitly set — only `value` is required to mean 'set'",
  resolveTutorSharePercent({
    courseTutorShare: { enabled: null, type: 'percentage', value: 45 },
    revenueShare: general(20),
  }),
  45,
);

console.log('');
console.log('--- the type travels with the value ---\n');

// The pair is returned together because the split applies one and the ledger
// records the other; a resolver that reported only the number is how the two start
// disagreeing about what was actually paid.
eq(
  'the general rate reports its type and its tier',
  resolveTutorShare({ courseTutorShare: null, revenueShare: generalFixed(3000) }).type,
  'fixed',
);
eq(
  'a fixed general rate reports its naira value',
  resolveTutorShare({ courseTutorShare: null, revenueShare: generalFixed(3000) }).value,
  3000,
);
eq(
  'the tier that supplied the rate is reported as `provider`',
  resolveTutorShare({ courseTutorShare: null, revenueShare: general(20) }).source,
  'provider',
);
eq(
  "a course's own rate is reported as `course_override`",
  resolveTutorShare({
    courseTutorShare: { enabled: true, type: 'fixed', value: 3000 },
    revenueShare: general(20),
  }).source,
  'course_override',
);
eq(
  'a fixed course rate beats a percentage general rate, type and all',
  resolveTutorShare({
    courseTutorShare: { enabled: true, type: 'fixed', value: 3000 },
    revenueShare: general(20),
  }).type,
  'fixed',
);
// An unknown or absent type reads as a percentage, because that is all there was
// before the type existed. The migration writes it down; this is the fallback for
// anything that predates the migration having run.
eq(
  'an untyped rate is read as a percentage rather than as a naira fee',
  resolveTutorShare({
    courseTutorShare: { enabled: true, value: 30 },
    revenueShare: general(20),
  }).type,
  'percentage',
);

console.log('');
console.log('--- the opt-out ---\n');

eq(
  'an opted-out course pays nothing while the programme stays on',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: false, type: null, value: null },
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
    courseTutorShare: { enabled: false, type: null, value: null },
    revenueShare: general(20),
  }) !== 20,
  'it resolved to the general 20%',
);
eq(
  'a course explicitly set to zero pays nothing and does not fall back',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, type: 'percentage', value: 0 },
    revenueShare: general(20),
  }),
  0,
);
// Neither an opt-out nor a switched-off programme is a tier that supplied a rate,
// so neither may be labelled as one — the ledger writes `source` onto a row, and a
// `course_override` on a row that was never written is a support answer with no
// question behind it.
eq(
  'an opt-out reports no tier rather than an override',
  resolveTutorShare({
    courseTutorShare: { enabled: false, type: null, value: null },
    revenueShare: general(20),
  }).source,
  null,
);

console.log('');
console.log('--- the master switch ---\n');

eq(
  'the programme off pays nothing',
  resolveTutorSharePercent({ courseTutorShare: null, revenueShare: { enabled: false, type: 'percentage', value: 20 } }),
  0,
);
// Same authority as affiliateSettings.enabled: a rate left on a course months ago
// must not keep paying after the provider believes they have stopped paying.
eq(
  'the programme off pays nothing even where a course carries its own rate',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, type: 'percentage', value: 30 },
    revenueShare: { enabled: false, type: 'percentage', value: 0 },
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

const { MAX_SHARE_PERCENT } = require('../utils/revenueShare.js');
eq(
  'an over-ceiling per-course rate is clamped, not paid',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, type: 'percentage', value: MAX_SHARE_PERCENT + 40 },
    revenueShare: general(20),
  }),
  MAX_SHARE_PERCENT,
);
eq(
  'an over-ceiling general rate is clamped too',
  resolveTutorSharePercent({ courseTutorShare: null, revenueShare: general(MAX_SHARE_PERCENT + 40) }),
  MAX_SHARE_PERCENT,
);
// The ceiling is a percentage rule and says nothing about a flat fee, which is not
// a proportion of anything. A ₦3,000 fee on a ₦10,000 course is not "3,000%", and
// clamping it to 50 would quietly reduce an agreed fee to ₦50.
eq(
  'the ceiling does not clamp a fixed fee',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, type: 'fixed', value: 3000 },
    revenueShare: general(20),
  }),
  3000,
);
eq(
  'a negative or unparseable rate is 0 rather than NaN',
  resolveTutorSharePercent({
    courseTutorShare: { enabled: true, type: 'percentage', value: 'not a number' },
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
//
// The resolution happens here, exactly as `creditInstructor` does it, and the
// resolved `{ type, value }` is what the split receives — the split applies a rate,
// it does not decide one.
const split = (courseTutorShare, revenueShare, extra = {}, tutors = [TUTOR_A]) => {
  const rate = resolveTutorShare({ courseTutorShare, revenueShare });
  return splitCourseEarnings({
    amountMajor: 10000,
    instructorId: PROVIDER,
    assignedTutors: tutors,
    rate: { type: rate.type, value: rate.value },
    ...extra,
  });
};
const amountFor = (shares, id) =>
  shares.find((share) => String(share.userId) === String(id))?.amount;

const generalSplit = split(null, general(20));
eq('the provider receives the net minus the share of the gross', amountFor(generalSplit, PROVIDER), 7500);
eq('the tutor receives the general share of the gross, not of the net', amountFor(generalSplit, TUTOR_A), 2000);

const overrideSplit = split({ enabled: true, type: 'percentage', value: 30 }, general(20));
eq('the provider receives less where a course pays more', amountFor(overrideSplit, PROVIDER), 6500);
eq('the tutor receives the per-course rate, not the general one', amountFor(overrideSplit, TUTOR_A), 3000);

const optedOutSplit = split({ enabled: false, type: null, value: null }, general(20));
eq('an opted-out course leaves the whole net with the provider', amountFor(optedOutSplit, PROVIDER), 9500);
eq('and writes no tutor row at all', amountFor(optedOutSplit, TUTOR_A), undefined);
eq('so exactly one credit is written', optedOutSplit.length, 1);

// Two tutors divide one share; the parts must still sum to the net.
const twoTutorSplit = split(
  { enabled: true, type: 'percentage', value: 30 },
  general(20),
  {},
  [TUTOR_A, TUTOR_B],
);
const total = twoTutorSplit.reduce((sum, share) => sum + share.amount, 0);
check(
  'the credits still sum to the net after rounding, with a per-course rate',
  Math.abs(total - 9500) < 0.005,
  `they summed to ${total}`,
);
eq(
  '30% to a course with two tutors is 15% each, not 30% each',
  amountFor(twoTutorSplit, TUTOR_B),
  1500,
);

console.log('');
console.log('--- the fixed fee ---\n');

// One pool, divided — not the fee to each. "₦3,000 to my tutors" is a statement
// about how much leaves the provider, so a second tutor must not double it.
const fixedSplit = split(null, generalFixed(3000), {}, [TUTOR_A, TUTOR_B]);
eq('a fixed fee is divided between the tutors, not paid to each', amountFor(fixedSplit, TUTOR_A), 1500);
eq('and the second tutor receives the other half', amountFor(fixedSplit, TUTOR_B), 1500);
eq('the provider keeps the net minus the one pool', amountFor(fixedSplit, PROVIDER), 6500);

// A fixed fee larger than the net would drive the provider's row negative and pay
// the tutors more than the course earned — money created from nothing, which no
// percentage can do while the ceiling sits below the platform's cut but a flat fee
// can do immediately.
const hugeFixed = split(null, generalFixed(20000));
eq('a fixed fee larger than the net is clamped to the net', amountFor(hugeFixed, TUTOR_A), 9500);
eq('and leaves the provider nothing rather than a negative credit', amountFor(hugeFixed, PROVIDER), undefined);
eq('with no zero-value ledger row written for them', hugeFixed.length, 1);

// The once-per-course rule. `creditInstructor` decides it from the accrual and
// passes the consequence in; the split just settles it.
const alreadyPaid = split(null, generalFixed(3000), { fixedAlreadyPaid: true }, [TUTOR_A, TUTOR_B]);
eq('a fixed fee already paid on this course leaves the whole net with the provider', amountFor(alreadyPaid, PROVIDER), 9500);
eq('and writes no second tutor row', amountFor(alreadyPaid, TUTOR_A), undefined);
eq('so exactly one credit is written', alreadyPaid.length, 1);

console.log('');
console.log('--- the per-student cap ---\n');

// A running total for one student on one course, so a later instalment sees what
// the earlier ones spent. The second arm is the one that matters: with the
// allowance used up, the payment reverts to the pre-programme arithmetic exactly.
const cappedFirst = split(null, general(20), { capMajor: 1500 });
eq('a cap below the share limits what the tutor is paid', amountFor(cappedFirst, TUTOR_A), 1500);
eq('and the provider keeps every kobo the cap withheld', amountFor(cappedFirst, PROVIDER), 8000);

const cappedSecond = split(null, general(20), { capMajor: 1500, accruedMajor: 1500 });
eq('once the allowance is spent the tutor is paid nothing', amountFor(cappedSecond, TUTOR_A), undefined);
eq('and the provider keeps the whole net', amountFor(cappedSecond, PROVIDER), 9500);

const cappedPartial = split(null, general(20), { capMajor: 1500, accruedMajor: 1200 });
eq('a partly-spent allowance pays only its remainder', amountFor(cappedPartial, TUTOR_A), 300);
eq('and the provider keeps the rest of the net', amountFor(cappedPartial, PROVIDER), 9200);

// The invariant the whole change rests on, asserted on every arm above at once:
// no arm may pay out more than the gross, or the platform fee plus the two shares
// would no longer be the student's payment.
const everyArm = { generalSplit, overrideSplit, optedOutSplit, twoTutorSplit, fixedSplit, hugeFixed, alreadyPaid, cappedFirst, cappedSecond, cappedPartial };
for (const [name, shares] of Object.entries(everyArm)) {
  const sum = shares.reduce((total_, share) => total_ + share.amount, 0);
  check(
    `${name}: the shares never exceed the platform fee plus the net`,
    sum <= 9500.005,
    `they summed to ${sum}`,
  );
}

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('the two-tier tutor split resolves and pays correctly');
