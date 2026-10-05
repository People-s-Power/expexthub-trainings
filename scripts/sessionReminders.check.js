// Check who a reminder goes to, what it says, and how a series is described to
// Google Calendar.
//
// The sweep itself needs a database, so what is checked here is everything it
// decides before it touches one: the audience drawn from a record, the wording,
// the identity of a session, and the query that decides which records are even
// looked at. That last one is here for a reason — a course with no `endDate` on
// it is invisible to an `endDate: { $gte: ... }` filter, and a whole term of
// reminders would go missing in a way that looks exactly like a working sweep.
//
//   node scripts/sessionReminders.check.js
//
// No database, no network, no server. Requiring the service registers its
// mongoose models but opens no connection, so nothing here queries anything.
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const reminders = require('../services/sessionReminderService.js');
const { platformTimezone, REMINDER_OFFSETS } = require('../utils/sessionOccurrences.js');

const ZONE = platformTimezone();
const LAGOS = ZONE === 'Africa/Lagos';

const offset = (key) => REMINDER_OFFSETS.find((entry) => entry.key === key);

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

// 09:00 in Lagos, which is the instant a 09:00 class resolves to there.
const START = new Date('2026-10-10T08:00:00.000Z');

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

function expect(problems, actual, wanted, what) {
  if (actual !== wanted) problems.push(`${what}: expected ${wanted}, got ${actual}`);
}

function expectIncludes(problems, haystack, needle, what) {
  if (!String(haystack).includes(needle)) problems.push(`${what}: ${JSON.stringify(haystack)} omits ${JSON.stringify(needle)}`);
}

console.log(`platform timezone: ${ZONE}\n`);

// --- the identity of one session --------------------------------------------

check('a session is identified by its record and its start, not the record alone', () => {
  const problems = [];
  const monday = reminders.occurrenceKey('course', A, START);
  const wednesday = reminders.occurrenceKey('course', A, new Date('2026-10-12T08:00:00.000Z'));

  expect(problems, monday, `course:${A}:2026-10-10T08:00:00.000Z`, 'monday');
  if (monday === wednesday) problems.push('two sessions of one course share an id');

  // The five offsets of one session share the id and are told apart by the
  // `offset` column, so a Monday reminder cannot suppress a Wednesday one.
  expect(problems, reminders.occurrenceKey('course', A, START), monday, 'stable across offsets');

  // The calendar write keys on the record alone: one entry per series.
  expect(problems, reminders.occurrenceKey('course', A), `course:${A}`, 'series key');
  return problems;
});

// --- who is told -------------------------------------------------------------

check('everyone enrolled, booked, teaching or assigned is told, once each', () => {
  const problems = [];
  const audience = reminders.reminderAudience(
    {
      enrolledStudents: [A, B],
      // The same learner is routinely both enrolled and on a payment plan, and
      // is reminded once for it.
      enrollments: [{ user: B }, { user: C }],
      instructorId: C,
      assignedTutors: [A, B],
    },
    'course',
  );

  expect(problems, audience.sort().join(','), [A, B, C].sort().join(','), 'audience');
  return problems;
});

check('an appointment reaches both parties', () => {
  const problems = [];
  const audience = reminders.reminderAudience({ from: A, to: B }, 'appointment');
  expect(problems, audience.sort().join(','), [A, B].sort().join(','), 'audience');
  return problems;
});

check('an event reaches its enrollees and its author', () => {
  const problems = [];
  const audience = reminders.reminderAudience({ enrolledStudents: [A], authorId: B }, 'event');
  expect(problems, audience.sort().join(','), [A, B].sort().join(','), 'audience');
  return problems;
});

check('a populated reference and a bare id name the same person', () => {
  const problems = [];
  const populated = reminders.reminderAudience(
    { enrolledStudents: [{ _id: A, fullname: 'Ada' }], instructorId: { _id: B } },
    'course',
  );
  expect(problems, populated.sort().join(','), [A, B].sort().join(','), 'audience');
  return problems;
});

check('a malformed reference is dropped rather than written as a broken recipient', () => {
  const problems = [];
  // A stale string id would make the dispatch insert throw a CastError, and the
  // sweep would lose every other reminder on the record with it.
  const audience = reminders.reminderAudience(
    { enrolledStudents: [A, 'not-an-id', null, undefined, ''], instructorId: 'nope' },
    'course',
  );
  expect(problems, audience.join(','), A, 'audience');
  expect(problems, reminders.reminderAudience(null, 'course').length, 0, 'null record');
  return problems;
});

// --- what it says ------------------------------------------------------------

check('a class reminder names the class, the time and the zone', () => {
  const problems = [];
  const copy = reminders.reminderCopy('course', { title: 'Intro to Python' }, { start: START }, offset('30m'), null);

  expect(problems, copy.title, 'Class in 30 minutes', 'title');
  expectIncludes(problems, copy.content, 'Intro to Python', 'content');
  expectIncludes(problems, copy.content, dayjs(START).tz(ZONE).format('HH:mm'), 'content time');
  expectIncludes(problems, copy.content, ZONE, 'content zone');
  if (LAGOS) expectIncludes(problems, copy.content, 'Sat, 10 Oct 2026 at 09:00', 'content');
  return problems;
});

check('the reminder that fires as the session starts is not phrased as a countdown', () => {
  const problems = [];
  const copy = reminders.reminderCopy('course', { title: 'Intro to Python' }, { start: START }, offset('start'), null);
  expect(problems, copy.title, 'Class starting now', 'title');
  if (String(copy.title).includes('in 0')) problems.push('title counts down to zero');
  expectIncludes(problems, copy.emailBody, 'is starting now', 'email body');
  return problems;
});

check('an event and an appointment are named as themselves, not as a class', () => {
  const problems = [];
  const event = reminders.reminderCopy('event', { title: 'Open Day' }, { start: START }, offset('4h'), null);
  expect(problems, event.title, 'Event in 4 hours', 'event title');

  const appt = reminders.reminderCopy('appointment', { title: 'Check-in' }, { start: START }, offset('1h'), null);
  expect(problems, appt.title, 'Appointment in 1 hour', 'appointment title');
  expect(problems, event.emailType, 'Event reminder', 'event email type');
  expect(problems, appt.emailType, 'Appointment reminder', 'appointment email type');
  return problems;
});

check('each side of an appointment is told about the other side', () => {
  const problems = [];
  const record = {
    from: { _id: A, fullname: 'Ada' },
    to: { _id: B, fullname: 'Bola' },
  };

  expectIncludes(problems, reminders.reminderCopy('appointment', record, { start: START }, offset('30m'), A).content, 'Bola', 'recipient is the host');
  expectIncludes(problems, reminders.reminderCopy('appointment', record, { start: START }, offset('30m'), B).content, 'Ada', 'recipient is the guest');
  return problems;
});

check('an appointment with nothing to name still reads as a reminder', () => {
  const problems = [];
  const copy = reminders.reminderCopy('appointment', {}, { start: START }, offset('30m'), A);
  expect(problems, copy.title, 'Appointment in 30 minutes', 'title');
  expectIncludes(problems, copy.content, 'Appointment', 'content');
  return problems;
});

// --- the weekly rule written onto someone's calendar -------------------------

check('a scheduled course becomes one weekly rule covering the series', () => {
  const problems = [];
  const rule = reminders.seriesRecurrence(
    {
      endDate: '2026-10-20',
      days: [
        { checked: true, day: 'Monday', startTime: '09:00', endTime: '11:00' },
        { checked: false, day: 'Tuesday', startTime: '09:00', endTime: '11:00' },
        { checked: true, day: 'Wednesday', startTime: '09:00', endTime: '11:00' },
      ],
    },
    'course',
    START,
  );

  expectIncludes(problems, rule, 'FREQ=WEEKLY', 'rule');
  expectIncludes(problems, rule, 'BYDAY=MO,WE', 'rule days');
  if (!/UNTIL=\d{8}T\d{6}Z$/.test(String(rule))) problems.push(`UNTIL is not a Google timestamp: ${rule}`);
  if (LAGOS) expect(problems, rule, 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261020T225959Z', 'rule');
  return problems;
});

check('nothing is repeated where there is nothing to repeat', () => {
  const problems = [];
  const days = [{ checked: true, day: 'Monday', startTime: '09:00', endTime: '11:00' }];

  expect(problems, reminders.seriesRecurrence({ endDate: '2026-10-20', days }, 'appointment', START), null, 'appointment');
  expect(problems, reminders.seriesRecurrence({ endDate: '2026-10-20' }, 'course', START), null, 'no schedule');
  expect(problems, reminders.seriesRecurrence({ endDate: '2026-10-20', days: [{ checked: false, day: 'Monday', startTime: '09:00', endTime: '11:00' }] }, 'course', START), null, 'nothing checked');
  // A schedule with no end date is treated as a single session by
  // `sessionOccurrences`, so a rule with no UNTIL would repeat it forever.
  expect(problems, reminders.seriesRecurrence({ days }, 'course', START), null, 'no end date');
  return problems;
});

check('a rule is not written for a series that has already finished', () => {
  const problems = [];
  // Google rejects a recurrence whose UNTIL precedes its own start, and the
  // whole write would fail rather than the rule being dropped.
  const rule = reminders.seriesRecurrence(
    { endDate: '2026-10-01', days: [{ checked: true, day: 'Monday', startTime: '09:00', endTime: '11:00' }] },
    'course',
    START,
  );
  expect(problems, rule, null, 'rule');
  return problems;
});

// --- which records the sweep even looks at -----------------------------------

check('the course query reaches a course with no end date, and skips a finished one', () => {
  const problems = [];
  const course = reminders.SOURCES.find((entry) => entry.kind === 'course');
  const query = course.query('2026-10-04', '2026-10-07T23:59:59.999Z');
  const clauses = JSON.stringify(query.$or);

  expect(problems, query.startDate.$lte, '2026-10-07T23:59:59.999Z', 'upper bound');
  if (!clauses.includes('$exists')) problems.push('a course with no endDate is never found');
  if (!clauses.includes('$gte')) problems.push('a course that has finished is not excluded');
  return problems;
});

check('the appointment query is a range over days and skips cancelled ones', () => {
  const problems = [];
  const appointment = reminders.SOURCES.find((entry) => entry.kind === 'appointment');
  const query = appointment.query('2026-10-04', '2026-10-07T23:59:59.999Z');

  expect(problems, query.date.$gte, '2026-10-04', 'lower bound');
  expect(problems, query.date.$lte, '2026-10-07T23:59:59.999Z', 'upper bound');
  expect(problems, query.status.$ne, 'cancelled', 'status');
  return problems;
});

check('every source can expand a record into the sessions it describes', () => {
  const problems = [];
  reminders.SOURCES.forEach((source) => {
    if (typeof source.occurrences !== 'function') problems.push(`${source.kind} cannot be expanded`);
    if (typeof source.query !== 'function') problems.push(`${source.kind} cannot be queried`);
  });
  const kinds = reminders.SOURCES.map((entry) => entry.kind).join(',');
  expect(problems, kinds, 'course,event,appointment', 'kinds');
  return problems;
});

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
