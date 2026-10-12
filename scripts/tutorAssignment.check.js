// Prove that a tutor who registers through the form is offered for assignment,
// that assigning and removing them actually moves the course's `assignedTutors`,
// and that a payment which pays no tutor says why.
//
// This is the reported cluster: "new tutor registration is not showing", "fees
// paid did not split between the provider and the tutor even after setting".
// The two are one story. A tutor who signs up through the form is stored with
// role `provider` (SignUpComp sends userType "provider"; determineRole maps it
// through unchanged) while the tutor lists filtered on the literal 'tutor' — so
// the provider could not pick the tutor they had just created. With nobody
// assigned, `splitCourseEarnings` hands the provider the whole net and writes no
// tutor row, and says nothing about why.
//
//   node scripts/tutorAssignment.check.js
//
// No database and no network. The User stand-in matches the filter it is handed
// the way MongoDB would, so a filter naming only one role returns only that
// role's accounts and the run fails rather than passing quietly.

const mongoose = require('mongoose');
const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Notification = require('../models/notifications.js');
const { splitCourseEarnings, explainNoTutorShare } = require('../services/coursePaymentService.js');

const OWNER = 'a'.repeat(24);
const FORM_TUTOR = 'b'.repeat(24);   // signed up through the form -> role 'provider'
const OAUTH_TUTOR = 'c'.repeat(24);  // came in through Google      -> role 'tutor'
const STRANGER = 'd'.repeat(24);
const STUDENT = 'e'.repeat(24);
const COURSE = '1'.repeat(24);
const DATA_COURSE = 'data-analytics';

const ACCOUNTS = [
  { _id: OWNER, role: 'provider', fullname: 'Owner Provider', email: 'owner@example.com', assignedCourse: null },
  { _id: FORM_TUTOR, role: 'provider', fullname: 'Ada Form', email: 'ada@example.com', assignedCourse: DATA_COURSE },
  { _id: OAUTH_TUTOR, role: 'tutor', fullname: 'Ben Google', email: 'ben@example.com', assignedCourse: null },
  { _id: STUDENT, role: 'client', fullname: 'Chidi Student', email: 'chidi@example.com' },
  { _id: STRANGER, role: 'affiliate', fullname: 'Dara Affiliate', email: 'dara@example.com' },
];

// --- the stand-ins -----------------------------------------------------------

const seen = { userFind: [], courseSave: 0, notifications: 0 };

// Matches the way MongoDB would: `$in` keeps only the named roles, a bare value
// keeps only that one, and any other field must be equal. A filter that names
// the wrong role therefore returns the wrong accounts here too.
User.find = async (filter = {}) => {
  seen.userFind.push(filter);
  const roleClause = filter.role;
  const roles = roleClause && typeof roleClause === 'object' && Array.isArray(roleClause.$in)
    ? roleClause.$in
    : (roleClause === undefined ? null : [roleClause]);
  return ACCOUNTS.filter((account) => {
    if (roles && !roles.includes(account.role)) return false;
    if (filter.assignedCourse !== undefined && account.assignedCourse !== filter.assignedCourse) return false;
    return true;
  });
};

// Enough of a document for the controller: an `assignedTutors` array it pushes
// to, filters and reassigns, and a `save` that records the write.
//
// The array casts what is pushed into it, because the real schema path is
// `[ObjectId]` and that cast is the whole defect: `assignedTutors.push(id)` with
// a string body id stores an ObjectId, so the next request's
// `assignedTutors.includes(id)` compares an ObjectId against a string and is
// false for every element. A stand-in holding plain strings would "fix" the old
// code by accident and the reproduction would be of a different bug.
const fakeCourse = (assignedTutors, { cast = true } = {}) => {
  const list = cast
    ? assignedTutors.map((id) => new mongoose.Types.ObjectId(id))
    : assignedTutors.slice();
  list.push = function push(...ids) {
    return Array.prototype.push.apply(
      this,
      ids.filter(Boolean).map((id) => new mongoose.Types.ObjectId(id))
    );
  };

  const course = {
    _id: new mongoose.Types.ObjectId(COURSE),
    title: 'Data Analytics',
    instructorId: OWNER,
    assignedTutors: list,
    contact: true,
    save: async () => { seen.courseSave += 1; },
  };
  return course;
};

let course = fakeCourse([]);
Course.findById = async () => course;

User.findById = async (id) => {
  const found = ACCOUNTS.find((a) => String(a._id) === String(id));
  if (!found) return null;
  return { ...found, teamMembers: [] };
};

Notification.create = async () => { seen.notifications += 1; };

const userControllers = require('../controllers/userController.js');
const courseControllers = require('../controllers/courseController.js');

// --- harness -----------------------------------------------------------------

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

const call = (controller, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    try {
      const out = controller(req, res);
      if (out && typeof out.catch === 'function') out.catch(reject);
    } catch (error) {
      reject(error);
    }
  });

const assign = (callerId, tutorId) =>
  call(courseControllers.assignTutor, {
    params: { courseId: COURSE },
    body: { id: tutorId },
    user: { id: callerId },
    headers: {},
  });

async function main() {
  // --- 1. a form-registered tutor is offered for assignment -------------------

  const offered = await call(userControllers.getInstructors, { user: { id: OWNER } });
  const names = (offered.body?.instructors || []).map((i) => i.fullname).sort();
  console.log(`offered for assignment: ${names.join(', ') || '(nobody)'}\n`);

  check('the assignment picker answers 200', offered.status === 200, `it answered ${offered.status}`);
  check(
    'the tutor who registered through the form is in it',
    names.includes('Ada Form'),
    `the picker offered ${names.join(', ') || '(nobody)'} — the form stores role 'provider'`
  );
  check(
    'the tutor who came in through Google is in it too',
    names.includes('Ben Google'),
    `the picker offered ${names.join(', ') || '(nobody)'}`
  );
  check(
    'a learner and an affiliate are not offered as tutors',
    !names.includes('Chidi Student') && !names.includes('Dara Affiliate'),
    `the picker offered ${names.join(', ')}`
  );
  const rolesAsked = seen.userFind[0]?.role?.$in;
  check(
    'the query asks for both tutor spellings rather than the literal',
    Array.isArray(rolesAsked) && rolesAsked.includes('tutor') && rolesAsked.includes('provider'),
    `it asked with ${JSON.stringify(seen.userFind[0]?.role)}`
  );

  // An empty directory is an answer, not a failure: the callers have no error
  // branch, so a 404 here was an unhandled rejection and a blank list.
  const originalFind = User.find;
  User.find = async () => [];
  const empty = await call(userControllers.getInstructors, { user: { id: OWNER } });
  User.find = originalFind;
  check(
    'no tutors yet answers 200 with an empty list, not 404',
    empty.status === 200 && Array.isArray(empty.body?.instructors) && empty.body.instructors.length === 0,
    `it answered ${empty.status} with ${JSON.stringify(empty.body?.instructors)}`
  );

  // --- 2. the learner's own tutor list uses the same spellings ---------------

  const mine = await call(userControllers.getMyInstructors, { body: { course: DATA_COURSE } });
  const mineNames = (mine.body?.instructors || []).map((i) => i.fullname);
  check(
    "a form-registered tutor appears in a learner's tutor list for their course",
    mineNames.includes('Ada Form'),
    `the list held ${mineNames.join(', ') || '(nobody)'}`
  );
  check(
    'and a tutor who declared no course is not listed against it',
    !mineNames.includes('Ben Google'),
    `the list held ${mineNames.join(', ')}`
  );

  // --- 3. assigning and removing a tutor actually moves the array ------------

  course = fakeCourse([]);

  const first = await assign(OWNER, FORM_TUTOR);
  check(
    'assigning adds the tutor',
    first.status === 200 && course.assignedTutors.map(String).join() === FORM_TUTOR,
    `${first.body?.message} left ${JSON.stringify(course.assignedTutors.map(String))}`
  );

  // The reported defect: this fell through to the assign branch because
  // `assignedTutors.includes(id)` compares ObjectIds against a string, so the
  // remove control pushed a second copy instead of taking the first away.
  const second = await assign(OWNER, FORM_TUTOR);
  check(
    'assigning the same tutor again removes them rather than duplicating',
    second.status === 200 && course.assignedTutors.length === 0 &&
      /unassigned/i.test(second.body?.message || ''),
    `${second.body?.message} left ${JSON.stringify(course.assignedTutors.map(String))}`
  );

  const third = await assign(OWNER, FORM_TUTOR);
  check(
    'and assigning once more puts them back, exactly once',
    third.status === 200 && course.assignedTutors.length === 1,
    `${third.body?.message} left ${JSON.stringify(course.assignedTutors.map(String))}`
  );

  // A course whose assignment was written in the other spelling must still let
  // the tutor be removed — the same two-spelling trap the ownership helpers
  // exist for.
  course = fakeCourse([FORM_TUTOR], { cast: false }); // plain string, not an ObjectId
  const legacy = await assign(OWNER, FORM_TUTOR);
  check(
    'a tutor stored in the plain-string spelling can still be removed',
    legacy.status === 200 && course.assignedTutors.length === 0,
    `${legacy.body?.message} left ${JSON.stringify(course.assignedTutors.map(String))}`
  );

  // --- 4. the removal is authorized exactly as the addition is ---------------

  course = fakeCourse([FORM_TUTOR]);
  seen.courseSave = 0;
  const refused = await assign(STRANGER, FORM_TUTOR);
  check(
    'a stranger cannot remove a tutor from somebody else\'s course',
    refused.status === 403 && course.assignedTutors.length === 1 && seen.courseSave === 0,
    `it answered ${refused.status} and left ${JSON.stringify(course.assignedTutors.map(String))}`
  );

  // An assigned tutor is a course manager, which is what the dashboard gate now
  // agrees with — and what the backend already allowed.
  course = fakeCourse([OAUTH_TUTOR]);
  const asTutor = await assign(OAUTH_TUTOR, FORM_TUTOR);
  check(
    'an assigned tutor may assign another tutor to the same course',
    asTutor.status === 200 && course.assignedTutors.length === 2,
    `it answered ${asTutor.status} — ${asTutor.body?.message}`
  );

  // --- 5. a payment that pays no tutor names the reason ---------------------

  const GROSS = 10000;
  const noRate = splitCourseEarnings({
    amountMajor: GROSS, instructorId: OWNER, assignedTutors: [FORM_TUTOR],
    rate: { type: 'percentage', value: 0 },
  });
  check(
    'with the share off the provider keeps the whole net',
    noRate.length === 1 && noRate[0].role === 'provider',
    JSON.stringify(noRate)
  );
  check(
    'and the log says it was the rate, not the assignment',
    /no rate resolved/.test(explainNoTutorShare({
      assignedTutors: [FORM_TUTOR], rateType: 'percentage', rateValue: 0,
    })),
    explainNoTutorShare({ assignedTutors: [FORM_TUTOR], rateType: 'percentage', rateValue: 0 })
  );

  // The data-level cause the settings screen cannot show: a rate that predates
  // the `percentage` -> `value` rename reads as 0, and the Share card renders it
  // as a rate that was never set.
  check(
    'a rate left under the pre-rename field name names the migration to run',
    /migrateTutorShareValue/.test(explainNoTutorShare({
      assignedTutors: [FORM_TUTOR], rateType: 'percentage', rateValue: 0, legacyRate: 20,
    })),
    explainNoTutorShare({
      assignedTutors: [FORM_TUTOR], rateType: 'percentage', rateValue: 0, legacyRate: 20,
    })
  );

  // The reported case: the rate was set, and there was nobody to pay.
  const noTutor = splitCourseEarnings({
    amountMajor: GROSS, instructorId: OWNER, assignedTutors: [],
    rate: { type: 'percentage', value: 20 },
  });
  check(
    'a rate with nobody assigned still leaves the provider the whole net',
    noTutor.length === 1 && noTutor[0].role === 'provider',
    JSON.stringify(noTutor)
  );
  check(
    'and the log names the missing assignment as the cause',
    /no tutor is assigned/.test(explainNoTutorShare({
      assignedTutors: [], rateType: 'percentage', rateValue: 20,
    })),
    explainNoTutorShare({ assignedTutors: [], rateType: 'percentage', rateValue: 20 })
  );
  check(
    'a flat fee already paid for this student says so',
    /already paid/.test(explainNoTutorShare({
      assignedTutors: [FORM_TUTOR], rateType: 'fixed', rateValue: 3000, accruedMinor: 300000,
    })),
    explainNoTutorShare({
      assignedTutors: [FORM_TUTOR], rateType: 'fixed', rateValue: 3000, accruedMinor: 300000,
    })
  );

  // The same payment with a tutor assigned does split — the contrast that shows
  // the three cases above are the whole of the difference.
  const split = splitCourseEarnings({
    amountMajor: GROSS, instructorId: OWNER, assignedTutors: [FORM_TUTOR],
    rate: { type: 'percentage', value: 20 },
  });
  const tutorRow = split.find((s) => s.role === 'tutor');
  check(
    'with a tutor assigned the same rate does pay them',
    Boolean(tutorRow) && tutorRow.userId === FORM_TUTOR && tutorRow.amount === 2000,
    JSON.stringify(split)
  );
  check(
    'and the parts still add up to the net',
    split.reduce((sum, s) => sum + s.amount, 0) === Math.round(GROSS * 0.95),
    `${split.reduce((sum, s) => sum + s.amount, 0)} against a net of ${Math.round(GROSS * 0.95)}`
  );

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('a form-registered tutor is assignable, removable, and paid when a rate is set');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
