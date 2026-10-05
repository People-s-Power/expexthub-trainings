// Drive the Send Mail audience endpoint and prove it reaches every course the
// provider owns — including the ones whose ownership is stored as a string.
//
// This is the reported bug: a training provider saw nine students in
// Admissions → My Students and two in Send Mail, both reading the same
// enrollment arrays. The ledger scopes through an aggregate, which never casts;
// the mailing audience scoped through `Course.find`, which casts the ownership
// filter against the schema and so could only ever reach the courses whose owner
// was stored as an ObjectId.
//
//   node scripts/myStudentsAudience.check.js
//
// No database and no network. The stand-ins are behavioural on purpose: the
// course lookup matches the filter it is handed the way MongoDB would, so a
// filter that never got awaited — the exact failure mode of forgetting the
// `await` in front of the shared helper — returns nothing and fails the run
// instead of passing quietly.

const mongoose = require('mongoose');
const Course = require('../models/courses.js');

const PROVIDER = 'a'.repeat(24);
const OTHER_PROVIDER = 'b'.repeat(24);
const ENROLLED_OLD = 'c'.repeat(24);
const ENROLLED_LEGACY = 'd'.repeat(24);

const courseId = (n) => String(n).repeat(24).slice(0, 24);

// The two kinds of course this provider owns. The distinction is not in the
// document — it is in how the owner was stored, which the filter is what has to
// cope with — so the ids the driver returns are simply the set the provider
// owns, both kinds together.
const OWNED_IDS = [courseId(1), courseId(2)];
const SOMEONE_ELSES = courseId(9);

const COURSES = {
  [OWNED_IDS[0]]: {
    _id: new mongoose.Types.ObjectId(OWNED_IDS[0]),
    title: 'Web Development Course',
    enrollments: [{ user: { _id: ENROLLED_OLD, fullname: 'Bernard', email: 'bernard@example.com' } }],
    enrolledStudents: [],
  },
  [OWNED_IDS[1]]: {
    _id: new mongoose.Types.ObjectId(OWNED_IDS[1]),
    title: 'Data Analytics Course',
    enrollments: [{ user: { _id: ENROLLED_LEGACY, fullname: 'Mercy', email: 'mercy@example.com' } }],
    enrolledStudents: [],
  },
  [SOMEONE_ELSES]: {
    _id: new mongoose.Types.ObjectId(SOMEONE_ELSES),
    title: 'Another Provider Course',
    enrollments: [{ user: { _id: 'e'.repeat(24), fullname: 'Stranger', email: 'x@example.com' } }],
    enrolledStudents: [],
  },
};

// --- the stand-ins -----------------------------------------------------------

const seen = { driverFilter: null, findFilter: null };

// The driver takes the filter as written, so this records the two spellings the
// ownership rule depends on.
Course.collection.distinct = async (field, filter) => {
  seen.driverFilter = filter;
  return OWNED_IDS.map((id) => new mongoose.Types.ObjectId(id));
};

// Matches on `_id.$in` the way MongoDB would. A filter that is still an
// un-awaited Promise carries no `_id`, matches nothing, and the run reports an
// empty audience rather than a false pass.
const courseChain = (records) => ({
  select: () => courseChain(records),
  populate: () => courseChain(records),
  lean: async () => records,
});

Course.find = (filter) => {
  seen.findFilter = filter;
  const wanted = (filter?._id?.$in || []).map(String);
  return courseChain(wanted.map((id) => COURSES[id]).filter(Boolean));
};

require('../models/coursePaymentPlans.js').find = () => courseChain([]);

require('../models/user.js').findById = (id) => ({
  select: () => ({ lean: async () => ({ _id: id, role: 'provider', teamMembers: [] }) }),
});

const userControllers = require('../controllers/userController.js');

const call = () =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    try {
      userControllers
        .getMyStudents({ user: { id: PROVIDER }, body: {}, headers: {} }, res)
        .catch(reject);
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

async function main() {
  const { status, body } = await call();

  check(
    'the provider is asked for their courses rather than refused',
    status === 200,
    `it answered ${status} — ${body?.message || ''}`
  );

  const names = (body.students || []).map((student) => student.fullname).sort();
  console.log(`audience: ${names.join(', ') || '(nobody)'}\n`);

  // The reported symptom, restated: the student on the course the old filter
  // could not reach used to be missing from this list and present in the ledger.
  check(
    'a student on every course the provider owns is in the audience',
    names.includes('Bernard') && names.includes('Mercy'),
    `the audience was ${names.join(', ') || '(empty)'}`
  );
  check(
    'nobody from another provider is in it',
    !names.includes('Stranger'),
    `the audience was ${names.join(', ')}`
  );
  check(
    'each course is counted once',
    (body.students || []).length === 2,
    `${(body.students || []).length} rows for 2 students`
  );

  // Why it can now see them: the ownership question went to the driver, which
  // does not cast, and both spellings travelled with it.
  const spellings = seen.driverFilter?.$or?.map((clause) =>
    Object.values(clause)[0].$in.map((value) => (value instanceof mongoose.Types.ObjectId ? 'ObjectId' : typeof value)).join('/')
  );
  check(
    'the ownership question kept both id spellings',
    Boolean(spellings) && spellings.every((pair) => pair === 'string/ObjectId'),
    `it asked with ${JSON.stringify(spellings)}`
  );
  check(
    'the course lookup was scoped by the ids that came back',
    Boolean(seen.findFilter?._id?.$in) && seen.findFilter._id.$in.length === OWNED_IDS.length,
    `it looked up with ${JSON.stringify(seen.findFilter)}`
  );

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('the mailing audience reaches every course the provider owns');
}

main();
