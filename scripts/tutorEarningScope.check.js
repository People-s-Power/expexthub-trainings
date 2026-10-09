// Prove the My Instructors screens are scoped, and stay scoped.
//
//   node scripts/tutorEarningScope.check.js
//
// No database and no network. The stand-ins are behavioural on purpose, as in
// scripts/tutorAudience.check.js: the ledger stand-in *applies* the filter it is
// handed the way MongoDB would, so a filter that was built but never passed to
// the query — the failure mode of assembling `scopeFilter(req)` and then
// forgetting to use it — returns every provider's rows and fails this run instead
// of passing quietly with a leak.
//
// This is the check that matters most on this surface. One provider reading
// another's earnings is not a cosmetic bug, and an empty result looks identical
// to a correct one from the inside.

const mongoose = require('mongoose');

const PROVIDER = 'a'.repeat(24);
const OTHER_PROVIDER = 'b'.repeat(24);
const MEMBER = 'e'.repeat(24); // a team member whose own account owns nothing
const TUTOR_ONE = 'c'.repeat(24);
const TUTOR_TWO = 'd'.repeat(24);

const oid = (hex) => new mongoose.Types.ObjectId(hex);

// --- the ledger, as it would be stored ---------------------------------------
//
// `providerId` is deliberately stored in both spellings: an ObjectId for one row,
// a plain string for the other, the way ids drifted on this data set. The screen
// has to read either, which is why the scope carries both.

const ROWS = [
  {
    _id: oid('1'.repeat(24)),
    earningRef: 'tutor-earning-txn-1-' + TUTOR_ONE,
    tutorId: { _id: oid(TUTOR_ONE), fullname: 'Ada' },
    studentId: { _id: oid('7'.repeat(24)), fullname: 'Student One', email: 'one@example.com' },
    courseId: { _id: oid('2'.repeat(24)), title: 'Web Development' },
    providerId: { _id: oid(PROVIDER), fullname: 'My Provider' },
    _providerKey: PROVIDER,
    baseAmount: 1000000,
    amount: 190000,
    rateType: 'percentage',
    rateValue: 20,
    rateSource: 'provider',
    status: 'available',
    holdUntil: new Date('2026-01-15'),
    releasedAt: new Date('2026-01-15'),
    createdAt: new Date('2026-01-01'),
  },
  {
    _id: oid('3'.repeat(24)),
    earningRef: 'tutor-earning-txn-2-' + TUTOR_TWO,
    tutorId: { _id: oid(TUTOR_TWO), fullname: 'Grace' },
    studentId: { _id: oid('8'.repeat(24)), fullname: 'Student Two', email: 'two@example.com' },
    courseId: { _id: oid('4'.repeat(24)), title: 'Data Analytics' },
    providerId: { _id: oid(OTHER_PROVIDER), fullname: 'Somebody Else' },
    // A string, not an ObjectId. A scope that only carried the ObjectId spelling
    // would drop this row from its own provider's view.
    _providerKey: OTHER_PROVIDER,
    baseAmount: 500000,
    amount: 95000,
    rateType: 'percentage',
    rateValue: 20,
    rateSource: 'course_override',
    status: 'pending',
    holdUntil: new Date('2026-02-01'),
    createdAt: new Date('2026-01-20'),
  },
];

/**
 * The filter, applied the way MongoDB applies it.
 *
 * Only the shapes this controller actually builds are handled — which is the
 * point: anything else is a filter this stand-in cannot honour, and it must fail
 * loudly rather than silently returning everything.
 */
function matches(row, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;

  for (const [key, condition] of Object.entries(filter)) {
    if (key === 'status') {
      if (row.status !== condition) return false;
      continue;
    }
    if (key === 'providerId') {
      const wanted = (condition?.$in || [condition]).map(String);
      if (!wanted.includes(row._providerKey)) return false;
      continue;
    }
    throw new Error(`the stand-in does not know how to apply \`${key}\` — if you added a filter, teach it here`);
  }
  return true;
}

const selected = (filter) => ROWS.filter((row) => matches(row, filter));

// --- the stand-ins -----------------------------------------------------------

const seen = { findFilter: null, countFilter: null, matchStage: null, distinctFilter: null };

const ledgerChain = (records) => ({
  populate: () => ledgerChain(records),
  sort: () => ledgerChain(records),
  skip: () => ledgerChain(records),
  limit: () => ledgerChain(records),
  lean: async () => records,
});

const TutorEarning = require('../models/tutorEarning.js');

TutorEarning.find = (filter) => {
  seen.findFilter = filter;
  return ledgerChain(selected(filter));
};

TutorEarning.countDocuments = async (filter) => {
  seen.countFilter = filter;
  return selected(filter).length;
};

TutorEarning.distinct = async (field, filter) => {
  seen.distinctFilter = filter;
  return [...new Set(selected(filter).map((row) => row._providerKey))];
};

TutorEarning.aggregate = async (pipeline) => {
  const match = pipeline[0]?.$match;
  seen.matchStage = match;
  const rows = selected(match);
  if (!rows.length) return [];

  const sum = (predicate) =>
    rows.reduce((total, row) => total + (predicate(row) ? row.amount : 0), 0);

  return [
    {
      commission: rows.reduce((total, row) => total + row.amount, 0),
      inHolding: sum((row) => row.status === 'pending'),
      available: sum((row) => row.status === 'available'),
      withdrawn: sum((row) => row.status === 'withdrawn'),
      studentFees: rows.reduce(
        (total, row) => total + (row.amount > 0 && row.status !== 'reversed' ? row.baseAmount : 0),
        0,
      ),
    },
  ];
};

// --- drive the endpoints -----------------------------------------------------

const controller = require('../controllers/tutorEarningController.js');

const call = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = {
      // Express's own default: `res.json` without an explicit `res.status` sends
      // 200, which is how every success path in this controller replies.
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, body: value });
        return this;
      },
    };
    try {
      handler(req, res).catch(reject);
    } catch (error) {
      reject(error);
    }
  });

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

const providerReq = () => ({ user: { id: PROVIDER, role: 'provider' }, query: {}, headers: {} });
const adminReq = () => ({ user: { id: 'f'.repeat(24), role: 'admin' }, query: {}, headers: {} });
// A delegated team member: their own account owns nothing, so the scope has to
// come from the acting owner rather than from `req.user`.
const memberReq = () => ({
  user: { id: MEMBER, role: 'affiliate' },
  scopeUserId: PROVIDER,
  query: {},
  headers: { 'x-acting-owner': PROVIDER },
});

async function main() {
  console.log('--- a provider sees their own rows ---\n');

  const providerList = await call(controller.listInstructors, providerReq());
  const providerRefs = (providerList.body.records || []).map((row) => row.ref);

  eq('the provider is served rather than refused', providerList.status, 200);
  eq('and sees exactly their own earning', providerRefs.length, 1);
  check(
    "and not the other provider's",
    !providerRefs.includes('tutor-earning-txn-2-' + TUTOR_TWO),
    'another provider\'s earning was returned',
  );
  // The filter itself, not just the outcome: a filter built and then not used
  // would still have shown one row here by luck on a two-row fixture.
  check(
    'the query carries a provider scope rather than none',
    Boolean(seen.findFilter && seen.findFilter.providerId),
    `the filter was ${JSON.stringify(seen.findFilter)}`,
  );
  check(
    'the scope carries both spellings, so a string-stored owner is not missed',
    (seen.findFilter?.providerId?.$in || []).length === 2,
    `the scope was ${JSON.stringify(seen.findFilter?.providerId)}`,
  );
  check(
    'the count is scoped with the same filter as the page of rows',
    JSON.stringify(seen.countFilter) === JSON.stringify(seen.findFilter),
    'the count and the page disagreed about what to count',
  );

  console.log('');
  console.log('--- a delegated member sees the account they are working in ---\n');

  const memberList = await call(controller.listInstructors, memberReq());
  const memberRefs = (memberList.body.records || []).map((row) => row.ref);

  eq('the member is served rather than refused', memberList.status, 200);
  eq("and sees the acting provider's earning", memberRefs.length, 1);
  check(
    'which is the provider\'s scope, not the member\'s own empty one',
    memberRefs[0] === 'tutor-earning-txn-1-' + TUTOR_ONE,
    `returned ${memberRefs.join(', ') || '(nothing)'}`,
  );

  console.log('');
  console.log('--- an admin sees the platform ---\n');

  const adminList = await call(controller.listInstructors, adminReq());
  const adminRefs = (adminList.body.records || []).map((row) => row.ref);

  eq('the admin is served', adminList.status, 200);
  eq('and sees every earning on the platform, not one provider\'s', adminRefs.length, 2);
  eq(
    'the admin query carries no provider scope at all',
    JSON.stringify(seen.findFilter),
    JSON.stringify({}),
  );
  check(
    'and the admin rows name the provider each earning belongs to',
    (adminList.body.records || []).every((row) => row.provider?.fullname),
    'a row arrived with no provider to attribute it to',
  );
  check(
    'while a provider\'s rows do not, since it would only repeat their own name',
    (providerList.body.records || []).every((row) => row.provider === undefined),
    'the provider payload was told about a provider it already knows',
  );

  console.log('');
  console.log('--- the summary is scoped the same way ---\n');

  const providerSummary = await call(controller.summary, providerReq());
  check(
    'the summary applies a provider scope to the aggregate',
    Boolean(seen.matchStage && seen.matchStage.providerId),
    `the $match was ${JSON.stringify(seen.matchStage)}`,
  );
  eq(
    "and totals only the provider's own earning",
    providerSummary.body.summary.commission,
    1900,
  );
  eq(
    "not the other provider's, which would have made it 2850",
    providerSummary.body.summary.commission === 2850,
    false,
  );
  eq('and counts one instructor rather than two', providerSummary.body.summary.instructors, 1);
  // 190000 kobo of a 1000000 kobo fee, converted to naira at the edge.
  eq('the student fee is reported in naira, not kobo', providerSummary.body.summary.studentFees, 10000);
  eq('and the released earning is reported as available', providerSummary.body.summary.available, 1900);
  eq('with nothing left in holding', providerSummary.body.summary.inHolding, 0);

  const adminSummary = await call(controller.summary, adminReq());
  eq(
    'the admin summary is the whole platform',
    adminSummary.body.summary.commission,
    2850,
  );
  eq('across both instructors', adminSummary.body.summary.instructors, 2);
  eq('with the one pending earning counted as in holding', adminSummary.body.summary.inHolding, 950);

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('the My Instructors screens are scoped, and an admin sees the platform');
}

main().catch((error) => {
  console.error('the scope check itself failed:', error);
  process.exit(1);
});
