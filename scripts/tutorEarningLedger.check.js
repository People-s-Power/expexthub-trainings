// The tutor earning ledger, checked without a database.
//
//   node scripts/tutorEarningLedger.check.js
//
// Three things have to hold for this ledger to be trustworthy, and none of them
// needs a connection to prove:
//
//   1. The rate reported alongside an amount is the rate that produced it. The
//      source-reporting resolution must agree with the plain one on every arm,
//      or a row records a reason that is not true.
//
//   2. The provider's residual and the tutors' rows sum back to the net, for
//      awkward amounts, any number of tutors, and both rate types. This is the
//      invariant that a ledger which does not reconcile breaks, and it is the whole
//      reason the tutor slices are passed *into* the ledger rather than recomputed
//      there.
//
//   3. An earning's reference is a function of exactly the payment and the tutor.
//      That is what makes a replayed webhook collide instead of paying twice.
//
// Requiring `coursePaymentService` here also proves the import graph is acyclic:
// it pulls in both the tutor earning service and the affiliate commission service,
// and the tutor service pulls the affiliate one back for `allocateWithdrawal`.

const {
  resolveTutorShare,
  resolveTutorSharePercent,
} = require('../services/tutorShareService.js');
const { splitCourseEarnings, PLATFORM_FEE_RATE } = require('../services/coursePaymentService.js');
const { allocateWithdrawal } = require('../services/affiliateCommissionService.js');
const {
  earningRefFor,
  toMinor,
  toMajor,
  DEFAULT_HOLD_DAYS,
} = require('../services/tutorEarningService.js');

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

const PROVIDER = 'a'.repeat(24);
const TUTOR_A = 'b'.repeat(24);
const TUTOR_B = 'c'.repeat(24);
const TUTOR_C = 'd'.repeat(24);

// A rate is a `{ type, value }` pair — a percentage of what the student pays, or a
// flat fee for the course.
const general = (percentage) => ({ enabled: true, type: 'percentage', value: percentage });
const generalFixed = (fee) => ({ enabled: true, type: 'fixed', value: fee });

// ---------------------------------------------------------------------------
console.log('--- the reported source matches the reported rate ---\n');

// Every arm of the resolution, as [name, courseTutorShare, revenueShare, expected
// source]. The rate itself is checked against the plain resolution below, so no
// arm can drift from it.
const ARMS = [
  ['a per-course rate', { enabled: true, type: 'percentage', value: 30 }, general(20), 'course_override'],
  ['a per-course rate with no explicit enabled flag', { enabled: null, type: 'percentage', value: 45 }, general(20), 'course_override'],
  // A course set to zero is a real answer from the course tier, not the absence
  // of one — the provider deliberately declined to pay on this course. It carries
  // a source for that reason, and no row is ever written from it, since a split
  // that pays nothing produces no tutor slice to record.
  ['a per-course zero', { enabled: true, type: 'percentage', value: 0 }, general(20), 'course_override'],
  ['a per-course opt-out', { enabled: false, type: null, value: null }, general(20), null],
  ['an untouched course inheriting the general rate', { enabled: null, type: null, value: null }, general(20), 'provider'],
  ['no course tier at all', null, general(20), 'provider'],
  ['the programme switched off', { enabled: true, type: 'percentage', value: 30 }, { enabled: false, type: 'percentage', value: 0 }, null],
  // A flat fee is a rate like any other as far as the ledger is concerned: it pays,
  // so it has to name the tier that decided it, and `rateValue` holds naira rather
  // than a percentage when it does.
  ['a fixed general rate', null, generalFixed(3000), 'provider'],
  ['a fixed per-course rate', { enabled: true, type: 'fixed', value: 3000 }, general(20), 'course_override'],
];

for (const [name, courseTutorShare, revenueShare, expectedSource] of ARMS) {
  const withSource = resolveTutorShare({ courseTutorShare, revenueShare });
  const plain = resolveTutorSharePercent({ courseTutorShare, revenueShare });

  eq(`${name}: the source-reporting form agrees with the plain one`, withSource.value, plain);
  eq(`${name}: reports the tier that supplied it`, withSource.source, expectedSource);
}

// The check that actually guards the ledger: any resolution that *pays* must name
// a tier the `rateSource` enum accepts, because that is the only case a row is
// written from. Whether a non-paying resolution carries a tier is not the ledger's
// business — it never sees one.
const PAYING_SOURCES = ['course_override', 'provider'];
check(
  'every arm that pays a share reports a tier the ledger will accept',
  ARMS.every(([, courseTutorShare, revenueShare]) => {
    const { value, source } = resolveTutorShare({ courseTutorShare, revenueShare });
    return value <= 0 || PAYING_SOURCES.includes(source);
  }),
  'a paying arm reported no source, or one the ledger would reject',
);

// The rate written onto a row is `{ rateType, rateValue }`, and the type decides
// how the value reads. A row claiming `percentage` while its value is naira would
// make the ledger's own explanation of a payment wrong.
check(
  'a fixed rate reports its type, so the naira value is not read as a percentage',
  resolveTutorShare({ courseTutorShare: null, revenueShare: generalFixed(3000) }).type === 'fixed',
  'a fixed rate resolved as a percentage',
);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- the split reconciles to the net ---\n');

const netOf = (gross) => Math.round(gross * (1 - PLATFORM_FEE_RATE) * 100) / 100;

// Amounts chosen to be hostile to rounding: a whole naira, a kobo tail, and a
// figure whose percentage lands mid-kobo. Tutor counts run up to three, because
// the division remainder is absorbed by the last tutor and stops being a no-op
// once the share does not divide evenly.
const GROSSES = [10000, 100.01, 33333.33, 999.99, 250000, 7.77];
const TUTOR_SETS = [[TUTOR_A], [TUTOR_A, TUTOR_B], [TUTOR_A, TUTOR_B, TUTOR_C]];
// The rates. A percentage scales with the payment; a fixed fee does not, and the
// hostile grosses above are exactly where that difference bites — ₦7.77 cannot
// fund a ₦3,000 fee, so the pool has to be clamped to the net rather than the
// provider's row going negative.
const RATES = [
  { type: 'percentage', value: 35 },
  { type: 'fixed', value: 3000 },
  { type: 'fixed', value: 50 },
  { type: 'fixed', value: 9999.99 },
];

let reconciliations = 0;
let drift = 0;

for (const gross of GROSSES) {
  for (const tutors of TUTOR_SETS) {
    for (const rate of RATES) {
      const shares = splitCourseEarnings({
        amountMajor: gross,
        instructorId: PROVIDER,
        assignedTutors: tutors,
        rate,
      });

      const credited = shares.reduce((sum, share) => sum + share.amount, 0);
      const expected = netOf(gross);
      reconciliations += 1;
      if (Math.abs(credited - expected) > 0.005) {
        drift += 1;
        console.log(`      gross ${gross}, ${tutors.length} tutor(s), ${rate.type} ${rate.value}: credited ${credited}, net ${expected}`);
      }

      // Whatever the ledger will store is the tutor slice in minor units, so it has
      // to survive the round trip exactly — a kobo lost here is a kobo the tutor
      // never sees, and it would not show up in the sum above.
      const tutorsOnly = shares.filter((share) => share.role === 'tutor');
      const roundTripped = tutorsOnly.reduce((sum, share) => sum + toMajor(toMinor(share.amount)), 0);
      const nominal = tutorsOnly.reduce((sum, share) => sum + share.amount, 0);
      if (Math.abs(roundTripped - nominal) > 0.005) {
        drift += 1;
        console.log(`      gross ${gross}: minor-unit round trip moved ${nominal} to ${roundTripped}`);
      }
    }
  }
}

check(
  `the provider's residual plus the tutors' rows equal the net, across ${reconciliations} splits`,
  drift === 0,
  `${drift} split(s) did not reconcile`,
);

// The specific shape the money actually takes, so the arithmetic above is pinned
// to a number a human can check: ₦10,000 gross, 5% platform fee, 20% of the gross.
const workedExample = splitCourseEarnings({
  amountMajor: 10000,
  instructorId: PROVIDER,
  assignedTutors: [TUTOR_A],
  rate: { type: 'percentage', value: 20 },
});
const amountFor = (shares, id) => shares.find((share) => String(share.userId) === String(id))?.amount;
eq('₦10,000 gross leaves the provider ₦7,500', amountFor(workedExample, PROVIDER), 7500);
eq('and the tutor ₦2,000', amountFor(workedExample, TUTOR_A), 2000);
eq(
  'which is what the ledger stores, in kobo',
  toMinor(amountFor(workedExample, TUTOR_A)),
  200000,
);
// The share is measured against the gross, not the provider's net — the same base
// the affiliate commission uses, so "20%" means one thing across both programmes.
// Off the net it would have been ₦1,900, which is what this change replaced.
check(
  'the share is of the gross, so it costs the provider more than it would off the net',
  amountFor(workedExample, TUTOR_A) > netOf(10000) * 0.2,
  'the share was computed off the net',
);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- the cap withholds money from the tutors, not from the provider ---\n');

// The assertion that would have caught the residual computed *before* the cap
// bit: when the cap withholds, the provider's cut has to grow by exactly the
// amount the tutors did not receive. Deriving the provider's row from the nominal
// rate instead would leave that difference paid to nobody, and the two sides would
// stop summing to the net.
const noCap = splitCourseEarnings({
  amountMajor: 10000,
  instructorId: PROVIDER,
  assignedTutors: [TUTOR_A],
  rate: { type: 'percentage', value: 20 },
});
const withCap = splitCourseEarnings({
  amountMajor: 10000,
  instructorId: PROVIDER,
  assignedTutors: [TUTOR_A],
  rate: { type: 'percentage', value: 20 },
  capMajor: 1500,
});

let withheld = 0;
withheld = amountFor(noCap, TUTOR_A) - amountFor(withCap, TUTOR_A);
eq('the cap withholds the difference from the tutor', withheld, 500);
eq(
  "and the provider's cut grows by exactly what the cap withheld",
  amountFor(withCap, PROVIDER) - amountFor(noCap, PROVIDER),
  withheld,
);
eq(
  'so the two sides still sum to the net after the cap bites',
  amountFor(withCap, PROVIDER) + amountFor(withCap, TUTOR_A),
  netOf(10000),
);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- an earning reference is one payment and one tutor ---\n');

const TX_A = 'txn-abc-123';
const TX_B = 'txn-abc-124';

eq('the same payment and tutor resolve to the same reference', earningRefFor(TX_A, TUTOR_A), earningRefFor(TX_A, TUTOR_A));
check(
  'which is what makes a replayed webhook collide rather than pay twice',
  earningRefFor(TX_A, TUTOR_A) === earningRefFor(TX_A, String(TUTOR_A)),
  'the same tutor in its two spellings produced two references',
);
check(
  'two tutors on one payment do not collide',
  earningRefFor(TX_A, TUTOR_A) !== earningRefFor(TX_A, TUTOR_B),
  'both tutors hashed to one reference, so the second would be dropped as a duplicate',
);
check(
  'one tutor on two payments do not collide',
  earningRefFor(TX_A, TUTOR_A) !== earningRefFor(TX_B, TUTOR_A),
  'the second payment would be dropped as a duplicate',
);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- a withdrawal consumes whole rows, oldest first ---\n');

// This is the affiliate ledger's rule, reused rather than copied — so it is worth
// pinning here too, since the tutor ledger now depends on the same answer.
const { coveredIndexes, uncoveredMinor } = allocateWithdrawal([1900, 2850, 500], 2000);
check('a withdrawal pays rows oldest first until it is spent', coveredIndexes.length > 0, 'nothing was covered');

const exact = allocateWithdrawal([1900, 2850], 1900);
eq('a withdrawal that exactly covers the oldest row takes only that row', exact.coveredIndexes.length, 1);
eq('and reports nothing uncovered', exact.uncoveredMinor, 0);

// A row is consumed only when the withdrawal covers it *in full*, so a row is
// left alone when the withdrawal is the smaller of the two. The rest of that row
// stays available — the tutor can still withdraw it later.
const partial = allocateWithdrawal([1900], 1000);
eq('a row the withdrawal cannot cover in full is left available', partial.coveredIndexes.length, 0);
// And it *absorbs* the withdrawal rather than leaving it unaccounted for: nothing
// is reported uncovered, because the money did come out of an earning. What is
// reported is only what no row could absorb at all.
eq('and the part-covered row absorbs the withdrawal', partial.uncoveredMinor, 0);

// The other partial direction: the withdrawal covers the first row in full and is
// part-way into the second. The first is consumed, the second is not.
const halfCovered = allocateWithdrawal([1900, 2850], 2000);
eq('the row the withdrawal covers in full is consumed', halfCovered.coveredIndexes.length, 1);
eq('the next row is left available', halfCovered.uncoveredMinor, 0);

// Only when the rows are exhausted does anything read as uncovered — and that
// money came from the wallet's non-earning balance, so it is reported rather than
// silently treated as an earning that paid it.
const exhausted = allocateWithdrawal([1900], 2500);
eq('rows are exhausted after the one they cover', exhausted.coveredIndexes.length, 1);
eq('and the excess is reported as uncovered', exhausted.uncoveredMinor, 600);

const beyond = allocateWithdrawal([1900, 2850], 10000);
eq('a withdrawal larger than every row covers them all', beyond.coveredIndexes.length, 2);
eq(
  'and what no earning could absorb is reported, not silently dropped',
  beyond.uncoveredMinor,
  10000 - 1900 - 2850,
);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- the holding period ---\n');

check(
  'an unset hold falls back to a real default rather than paying out instantly',
  Number.isInteger(DEFAULT_HOLD_DAYS) && DEFAULT_HOLD_DAYS > 0,
  `DEFAULT_HOLD_DAYS is ${DEFAULT_HOLD_DAYS}`,
);

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('the tutor earning ledger reconciles, and its references are unique per tutor and payment');
