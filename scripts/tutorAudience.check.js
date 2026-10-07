// Drive the Send Mail tutor audience and prove it unions the two relationships
// that make someone "the provider's tutor" — assigned to one of their courses,
// or accepted onto their team — without reaching anyone else's.
//
//   node scripts/tutorAudience.check.js
//
// No database and no network. The stand-ins are behavioural on purpose, as in
// scripts/myStudentsAudience.check.js: the course lookup matches the filter it is
// handed the way MongoDB would, so a filter that never got awaited — the failure
// mode of dropping the `await` in front of the shared ownership helper — returns
// nothing and fails this run instead of passing quietly with an empty audience.

const mongoose = require('mongoose');
const Course = require('../models/courses.js');

const PROVIDER = 'a'.repeat(24);
const OTHER_PROVIDER = 'b'.repeat(24);

// The four ways someone can, or cannot, be in the audience.
const ASSIGNED_ONLY = 'c'.repeat(24); // teaches a course, never joined the team
const TEAM_ONLY = 'd'.repeat(24); // on the team, holds no course
const BOTH = 'e'.repeat(24); // both — must appear once, not twice
const INVITED_NOT_ACCEPTED = 'f'.repeat(24); // invited, still pending
const BLOCKED_TUTOR = '1'.repeat(24); // assigned, but the account is blocked
const NO_EMAIL_TUTOR = '2'.repeat(24); // assigned, only a phone number on file
const STRANGER = '9'.repeat(24); // another provider's tutor

const courseId = (n) => String(n).repeat(24).slice(0, 24);
const COURSE_ONE = courseId(3);
const COURSE_TWO = courseId(4);
const SOMEONE_ELSES = courseId(8);

const OWNED_IDS = [COURSE_ONE, COURSE_TWO];

const COURSES = {
  [COURSE_ONE]: {
    _id: new mongoose.Types.ObjectId(COURSE_ONE),
    title: 'Web Development',
    assignedTutors: [
      new mongoose.Types.ObjectId(ASSIGNED_ONLY),
      // Stored as a plain string, the way `instructorId` drifted on this data
      // set. The audience must read the id either way.
      BOTH,
      new mongoose.Types.ObjectId(BLOCKED_TUTOR),
      new mongoose.Types.ObjectId(NO_EMAIL_TUTOR),
    ],
  },
  [COURSE_TWO]: {
    _id: new mongoose.Types.ObjectId(COURSE_TWO),
    title: 'Data Analytics',
    assignedTutors: [new mongoose.Types.ObjectId(BOTH)],
  },
  [SOMEONE_ELSES]: {
    _id: new mongoose.Types.ObjectId(SOMEONE_ELSES),
    title: 'Another Provider Course',
    assignedTutors: [new mongoose.Types.ObjectId(STRANGER)],
  },
};

const TUTOR_PROFILES = {
  [ASSIGNED_ONLY]: { _id: ASSIGNED_ONLY, fullname: 'Ada', email: 'ada@example.com' },
  [TEAM_ONLY]: { _id: TEAM_ONLY, fullname: 'Sam', email: 'sam@example.com' },
  [BOTH]: { _id: BOTH, fullname: 'Grace', email: 'grace@example.com' },
  [INVITED_NOT_ACCEPTED]: { _id: INVITED_NOT_ACCEPTED, fullname: 'Pending Pat', email: 'pat@example.com' },
  [BLOCKED_TUTOR]: { _id: BLOCKED_TUTOR, fullname: 'Blocked Bob', email: 'bob@example.com', blocked: true },
  [NO_EMAIL_TUTOR]: { _id: NO_EMAIL_TUTOR, fullname: 'Phone Only Phil', email: null },
  [STRANGER]: { _id: STRANGER, fullname: 'Stranger', email: 'nobody@example.com' },
};

const ACCOUNTS = {
  [PROVIDER]: {
    _id: PROVIDER,
    role: 'provider',
    teamMembers: [
      { ownerId: PROVIDER, tutorId: TEAM_ONLY, status: 'accepted' },
      { ownerId: PROVIDER, tutorId: BOTH, status: 'accepted' },
      // Excluded: an unaccepted invitation is mail to a stranger about a team
      // they have not joined.
      { ownerId: PROVIDER, tutorId: INVITED_NOT_ACCEPTED, status: 'pending' },
    ],
  },
  [OTHER_PROVIDER]: { _id: OTHER_PROVIDER, role: 'provider', teamMembers: [] },
};

// --- the stand-ins -----------------------------------------------------------

const seen = { driverFilter: null, findFilter: null, userQuery: null };

// The driver takes the filter as written, so this records the two spellings the
// ownership rule depends on.
Course.collection.distinct = async (field, filter) => {
  seen.driverFilter = filter;
  return OWNED_IDS.map((id) => new mongoose.Types.ObjectId(id));
};

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

const userChain = (doc) => ({
  select: () => userChain(doc),
  populate: () => userChain(doc),
  lean: async () => doc,
});

const User = require('../models/user.js');

User.findById = (id) => userChain(ACCOUNTS[String(id)] || null);

User.find = (filter) => {
  seen.userQuery = filter;
  const wanted = (filter?._id?.$in || []).map(String);
  return userChain(wanted.map((id) => TUTOR_PROFILES[id]).filter(Boolean));
};

// --- drive the endpoint ------------------------------------------------------

const userControllers = require('../controllers/userController.js');

const call = (body = {}) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
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
      userControllers
        .getMyTutors({ user: { id: PROVIDER }, body, headers: {} }, res)
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
  const rows = body.tutors || [];
  const names = rows.map((row) => row.fullname).sort();
  const byName = new Map(rows.map((row) => [row.fullname, row]));

  console.log(`status ${status}`);
  console.log(`audience: ${names.join(', ') || '(nobody)'}\n`);

  check('the provider is asked for their tutors rather than refused', status === 200, `${status} — ${body?.message || ''}`);

  // Source one: a tutor on a course the provider owns.
  check(
    'a tutor assigned to a course is in the audience',
    names.includes('Ada'),
    `the audience was ${names.join(', ') || '(empty)'}`,
  );
  // Source two: a team member who holds no course at all. This is the half that
  // a course-only list would silently lose.
  check(
    'an accepted team member with no course is in the audience',
    names.includes('Sam'),
    `the audience was ${names.join(', ') || '(empty)'}`,
  );

  check(
    'someone who is both appears once',
    names.filter((name) => name === 'Grace').length === 1,
    `${names.filter((name) => name === 'Grace').length} rows for Grace`,
  );
  check(
    'their row carries every reason they are in it',
    (byName.get('Grace')?.courses || []).sort().join('|') === 'Data Analytics|Web Development',
    `courses were ${JSON.stringify(byName.get('Grace')?.courses)}`,
  );

  check(
    'a pending invitation is not a tutor yet',
    !names.includes('Pending Pat'),
    `the audience was ${names.join(', ')}`,
  );
  check(
    'nobody from another provider is in it',
    !names.includes('Stranger'),
    `the audience was ${names.join(', ')}`,
  );
  check(
    'a tutor on both courses is still one row',
    rows.length === 5,
    `${rows.length} rows for 5 tutors`,
  );

  // Rows that cannot be mailed are still returned, with the reason attached —
  // the same contract the student audience keeps, so the composer can disable
  // the row rather than the row vanishing.
  check(
    'a blocked tutor is returned and flagged',
    byName.get('Blocked Bob')?.blocked === true,
    `blocked was ${JSON.stringify(byName.get('Blocked Bob')?.blocked)}`,
  );
  check(
    'a tutor with no email is returned and flagged',
    byName.get('Phone Only Phil')?.hasEmail === false,
    `hasEmail was ${JSON.stringify(byName.get('Phone Only Phil')?.hasEmail)}`,
  );

  // Why it can see them: the ownership question went to the driver, which does
  // not cast, and both spellings travelled with it.
  const spellings = seen.driverFilter?.$or?.map((clause) =>
    Object.values(clause)[0].$in
      .map((value) => (value instanceof mongoose.Types.ObjectId ? 'ObjectId' : typeof value))
      .join('/'),
  );
  check(
    'the ownership question kept both id spellings',
    Boolean(spellings) && spellings.every((pair) => pair === 'string/ObjectId'),
    `it asked with ${JSON.stringify(spellings)}`,
  );
  check(
    'the course lookup was scoped by the ids that came back',
    seen.findFilter?._id?.$in?.length === OWNED_IDS.length,
    `it looked up with ${JSON.stringify(seen.findFilter)}`,
  );
  check(
    'the tutor profiles were fetched by the ids in the audience',
    (seen.userQuery?._id?.$in || []).length === 5,
    `it asked for ${JSON.stringify(seen.userQuery)}`,
  );

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('the tutor audience unions both relationships and reaches nobody else');
}

main();
