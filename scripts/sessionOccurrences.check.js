// Check that a session's start time is resolved correctly, and that the right
// reminder is chosen for it.
//
// This is the arithmetic the reminder sweep stands on, and it is the part of
// that engine most likely to be wrong in a way nobody notices: a reminder that
// fires at the wrong minute still looks like a reminder. So the two things
// worth pinning are that a wall-clock session time means the same instant on
// every server, and that each of the five offsets resolves exactly once as the
// clock passes it — never twice, and never at a minute it was not asked for.
//
//   node scripts/sessionOccurrences.check.js
//
// No database, no network, no server: this drives utils/sessionOccurrences.js on
// its own. Two of the checks pin the shipped default timezone's exact instant
// and are skipped when PLATFORM_TIMEZONE names another zone; the wall-clock
// assertions hold in every configuration.
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const occurrences = require('../utils/sessionOccurrences.js');

const ZONE = occurrences.platformTimezone();
const LAGOS = ZONE === 'Africa/Lagos';

const local = (date) => dayjs(date).tz(ZONE).format('YYYY-MM-DD HH:mm');
const instant = (date) => new Date(date).toISOString();

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

console.log(`platform timezone: ${ZONE}\n`);

// --- appointments: a wall-clock day and time in the platform zone ------------

check('an appointment resolves to its wall-clock time in the platform zone', () => {
  const problems = [];
  const appt = occurrences.appointmentOccurrence({ date: '2026-10-10', time: '09:00' });
  expect(problems, local(appt.start), '2026-10-10 09:00', 'start');
  if (LAGOS) expect(problems, instant(appt.start), '2026-10-10T08:00:00.000Z', 'instant');
  return problems;
});

check('startTime wins over the legacy time field when both are present', () => {
  const problems = [];
  const appt = occurrences.appointmentOccurrence({ date: '2026-10-10', startTime: '14:30', time: '09:00' });
  expect(problems, local(appt.start), '2026-10-10 14:30', 'start');
  return problems;
});

check('an appointment with no time reads as midnight in the platform zone', () => {
  const problems = [];
  const appt = occurrences.appointmentOccurrence({ date: '2026-10-10' });
  expect(problems, local(appt.start), '2026-10-10 00:00', 'start');
  return problems;
});

check('an appointment end time is resolved when the record carries one', () => {
  const problems = [];
  const appt = occurrences.appointmentOccurrence({ date: '2026-10-10', time: '09:00', endTime: '10:00' });
  expect(problems, local(appt.end), '2026-10-10 10:00', 'end');
  return problems;
});

check('an appointment with no usable date resolves to nothing rather than to now', () => {
  const problems = [];
  expect(problems, occurrences.appointmentOccurrence({ date: 'not a date', time: '09:00' }), null, 'unparseable');
  expect(problems, occurrences.appointmentOccurrence({}), null, 'empty');
  expect(problems, occurrences.appointmentOccurrence(null), null, 'null');
  return problems;
});

// --- courses and events without a schedule: one session on startDate ---------

check('a record with no schedule is a single session on its start date', () => {
  const problems = [];
  const list = occurrences.sessionOccurrences({ startDate: '2026-10-10', endDate: '2026-10-20' });
  expect(problems, list.length, 1, 'count');
  expect(problems, local(list[0].start), '2026-10-10 00:00', 'start');
  return problems;
});

check('a record with no schedule but a startTime is a session at that time', () => {
  const problems = [];
  // Online and offline events carry their real window in startTime/endTime and
  // no weekly days at all — the shape AddEvents validates for those two types.
  const list = occurrences.sessionOccurrences({ startDate: '2026-10-10', endDate: '2026-10-20', startTime: '09:00' });
  expect(problems, list.length, 1, 'count');
  expect(problems, local(list[0].start), '2026-10-10 09:00', 'start');
  return problems;
});

check('a record with no start date yields no sessions', () => {
  const problems = [];
  expect(problems, occurrences.sessionOccurrences({ endDate: '2026-10-20' }).length, 0, 'no startDate');
  expect(problems, occurrences.sessionOccurrences(null).length, 0, 'null');
  return problems;
});

// --- the weekly schedule -----------------------------------------------------

const COURSE = {
  startDate: '2026-10-05',
  endDate: '2026-10-16',
  days: [
    { checked: true, day: 'Monday', startTime: '09:00', endTime: '11:00' },
    { checked: false, day: 'Tuesday', startTime: '09:00', endTime: '11:00' },
    { checked: true, day: 'Wednesday', startTime: '09:00', endTime: '11:00' },
    { checked: true, day: 'Friday', startTime: '09:00', endTime: '11:00' },
  ],
};

check('a weekly schedule expands to every matching weekday, start to end inclusive', () => {
  const problems = [];
  const list = occurrences.sessionOccurrences(COURSE);
  expect(problems, list.map((x) => local(x.start).slice(0, 10)).join(','),
    '2026-10-05,2026-10-07,2026-10-09,2026-10-12,2026-10-14,2026-10-16', 'days');
  if (!list.every((x) => local(x.start).slice(11, 16) === '09:00')) problems.push('a start time drifted');
  if (!list.every((x) => local(x.end).slice(11, 16) === '11:00')) problems.push('an end time drifted');
  return problems;
});

check('a one-day course scheduled on its own weekday yields exactly that session', () => {
  const problems = [];
  const list = occurrences.sessionOccurrences({
    startDate: '2026-10-05',
    endDate: '2026-10-05',
    days: [{ checked: true, day: 'Monday', startTime: '09:00', endTime: '10:00' }],
  });
  expect(problems, list.length, 1, 'count');
  return problems;
});

check('a checked day that never falls inside the range yields no sessions', () => {
  const problems = [];
  const list = occurrences.sessionOccurrences({
    startDate: '2026-10-05',
    endDate: '2026-10-05',
    days: [{ checked: true, day: 'Sunday', startTime: '09:00', endTime: '10:00' }],
  });
  expect(problems, list.length, 0, 'count');
  return problems;
});

check('a schedule with no end date runs from its start date alone, not forever', () => {
  const problems = [];
  const list = occurrences.sessionOccurrences({
    startDate: '2026-10-05',
    days: [{ checked: true, day: 'Monday', startTime: '09:00', endTime: '10:00' }],
  });
  expect(problems, list.length, 1, 'count');
  return problems;
});

check('a checked day with no times is ignored', () => {
  const problems = [];
  const list = occurrences.sessionOccurrences({
    startDate: '2026-10-05',
    endDate: '2026-10-06',
    days: [
      { checked: true, day: 'Monday', startTime: '', endTime: '' },
      { checked: true, day: 'Tuesday', startTime: '09:00', endTime: '10:00' },
    ],
  });
  expect(problems, list.length, 1, 'count');
  expect(problems, local(list[0].start).slice(0, 10), '2026-10-06', 'day');
  return problems;
});

check('an ISO start date is reduced to its platform-zone day before the clock is applied', () => {
  const problems = [];
  const list = occurrences.sessionOccurrences({
    startDate: '2026-10-05T08:00:00.000Z',
    endDate: '2026-10-07T08:00:00.000Z',
    days: [{ checked: true, day: 'Monday', startTime: '09:00', endTime: '11:00' }],
  });
  expect(problems, list.length, 1, 'count');
  expect(problems, local(list[0].start), '2026-10-05 09:00', 'start');
  return problems;
});

if (LAGOS) {
  check('a late-evening instant lands on the next platform day, which a server-zone parse would miss', () => {
    const problems = [];
    const list = occurrences.sessionOccurrences({
      startDate: '2026-10-05T23:30:00.000Z',
      endDate: '2026-10-05T23:30:00.000Z',
    });
    expect(problems, local(list[0].start), '2026-10-06 00:00', 'start');
    return problems;
  });
}

// --- which reminder is due ---------------------------------------------------

const START = new Date('2026-10-10T08:00:00.000Z');
const before = (minutes) => new Date(START.getTime() - minutes * 60000);

check('a reminder is not due before its firing minute', () => {
  const problems = [];
  expect(problems, occurrences.dueReminder(START, before(24 * 60 + 1)), null, 'two days out');
  return problems;
});

check('a reminder is due on its firing minute exactly', () => {
  const problems = [];
  expect(problems, occurrences.dueReminder(START, before(24 * 60)).key, '24h', 'key');
  return problems;
});

check('each of the five offsets is resolved at its own firing time', () => {
  const problems = [];
  expect(problems, occurrences.dueReminder(START, before(4 * 60)).key, '4h', '4h');
  expect(problems, occurrences.dueReminder(START, before(60)).key, '1h', '1h');
  expect(problems, occurrences.dueReminder(START, before(30)).key, '30m', '30m');
  expect(problems, occurrences.dueReminder(START, START).key, 'start', 'start');
  return problems;
});

check('inside the catch-up window a delayed sweep still fires the offset it missed', () => {
  const problems = [];
  // Ten minutes late for a reminder that was due thirty minutes before the start.
  expect(problems, occurrences.dueReminder(START, before(20)).key, '30m', 'key');
  return problems;
});

check('past the catch-up window the offset is abandoned rather than fired very late', () => {
  const problems = [];
  // Sixteen minutes late, one past the window: the session is nearly here and a
  // reminder that arrives after it is worse than none.
  expect(problems, occurrences.dueReminder(START, before(14)), null, 'too late');
  return problems;
});

check('between two offsets nothing is due, so a sweep cannot double-announce', () => {
  const problems = [];
  expect(problems, occurrences.dueReminder(START, before(45)), null, 'midway');
  return problems;
});

check('every offset is offered, for its whole window, never two at once', () => {
  const problems = [];
  const seen = {};

  for (let m = 24 * 60 + 30; m >= -30; m--) {
    const at = before(m);
    const due = occurrences.dueReminder(START, at);
    if (due) seen[due.key] = (seen[due.key] || 0) + 1;

    // Deliberately not "exactly once": an offset is due on every pass inside
    // its window, which is what lets a delayed or restarted sweep still send
    // it. Doing it once is the dispatch row's job (models/reminderDispatch.js),
    // not this function's. What must hold here is that the windows never
    // overlap — the sweep sends one reminder per session per pass, so two
    // offsets due at the same minute would silently drop one of them.
    const claiming = occurrences.REMINDER_OFFSETS.filter((offset) => {
      const firesAt = START.getTime() - offset.minutes * 60000;
      return (
        at.getTime() >= firesAt &&
        at.getTime() < firesAt + occurrences.DUE_WINDOW_MINUTES * 60000
      );
    });
    if (claiming.length > 1) {
      problems.push(`${m} minutes out: ${claiming.map((c) => c.key).join(' and ')} overlap`);
    }
  }

  expect(problems, Object.keys(seen).sort().join(','), '1h,24h,30m,4h,start', 'offsets seen');
  Object.entries(seen).forEach(([key, count]) => {
    if (count !== occurrences.DUE_WINDOW_MINUTES) {
      problems.push(`${key} offered on ${count} minutes, expected ${occurrences.DUE_WINDOW_MINUTES}`);
    }
  });
  return problems;
});

check('an unusable start or clock yields nothing rather than a wrong reminder', () => {
  const problems = [];
  expect(problems, occurrences.dueReminder(new Date('nonsense'), new Date()), null, 'bad start');
  expect(problems, occurrences.dueReminder(START, new Date('nonsense')), null, 'bad clock');
  return problems;
});

check('the query lookahead reaches past the earliest offset, so nothing is missed', () => {
  const problems = [];
  if (!(occurrences.furthestLookaheadMinutes() > 24 * 60)) problems.push('lookahead is short of 24h');
  return problems;
});

check('a malformed clock is clamped into a real time instead of producing an invalid date', () => {
  const problems = [];
  expect(problems, occurrences.parseClock('09:05').hour, 9, 'hour');
  expect(problems, occurrences.parseClock('9:5').minute, 5, 'minute');
  expect(problems, occurrences.parseClock('').hour, 0, 'empty hour');
  expect(problems, occurrences.parseClock(undefined).minute, 0, 'undefined minute');
  expect(problems, occurrences.parseClock('25:99').hour, 23, 'clamped hour');
  expect(problems, occurrences.parseClock('25:99').minute, 59, 'clamped minute');
  expect(problems, occurrences.parseClock('nonsense').hour, 0, 'unparseable hour');
  return problems;
});

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
