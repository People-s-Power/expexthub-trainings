// Drive the reminder sweep end to end against stubbed models and prove the two
// things that would be worst to get wrong.
//
// The first is that a reminder is delivered to each person exactly once per
// session per offset. The sweep runs every five minutes and an offset stays due
// for fifteen, so a session is a candidate on three consecutive passes and is
// still a candidate after a restart — a second delivery is the failure mode, and
// it is invisible in a single run. The second is that a later offset still fires
// after an earlier one has been sent, which is what stops an over-eager guard
// from silently reducing five reminders to one.
//
//   node scripts/sessionReminderSweep.check.js
//
// No database and no network. The models are replaced by statics that answer
// from records defined here, `ReminderDispatch.create` enforces the unique index
// the real one declares, and the email and calendar channels are replaced by
// arrays. Substitutions are installed before the service is required, because it
// destructures what it needs at load time.
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const occurrences = require('../utils/sessionOccurrences.js');

// --- the records this run is about -------------------------------------------

const A = 'a'.repeat(24); // enrolled learner, Google linked
const B = 'b'.repeat(24); // instructor, Google linked
const C = 'c'.repeat(24); // assigned tutor, not Google linked
const D = 'd'.repeat(24); // the other side of the appointment

const DAY = '2026-10-10';
// Derived in the platform timezone rather than written out: which weekday a
// date falls on depends on the zone the schedule is read in, and a wrong name
// here would make the schedule silently empty instead of failing.
const DAY_NAME = occurrences.platformDay(DAY).format('dddd');

const COURSE = {
  _id: '1'.repeat(24),
  title: 'Intro to Python',
  about: 'Python from first principles',
  startDate: DAY,
  endDate: DAY,
  days: [{ checked: true, day: DAY_NAME, startTime: '09:00', endTime: '11:00' }],
  enrolledStudents: [A],
  instructorId: B,
  assignedTutors: [C],
  // Set by createGoogleMeet when the course was published, which is why the
  // instructor's entry is patched rather than duplicated.
  calendarEventId: 'host-event-123',
};

const APPOINTMENT = {
  _id: '2'.repeat(24),
  date: DAY,
  // Deliberately not the same hour as the course. Two sessions starting at the
  // same minute would both be due on every sweep, and a count that is wrong for
  // one of them could not be told apart from a count that is wrong for both.
  startTime: '14:00',
  endTime: '15:00',
  from: { _id: A, fullname: 'Ada' },
  to: { _id: D, fullname: 'Bola' },
};

const USERS = {
  [A]: { _id: A, email: 'ada@example.com', fullname: 'Ada', isGoogleLinked: true, googleRefreshToken: 'rt-a' },
  [B]: { _id: B, email: 'bola@example.com', fullname: 'Bola', isGoogleLinked: true, googleRefreshToken: 'rt-b' },
  [C]: { _id: C, email: 'chidi@example.com', fullname: 'Chidi', isGoogleLinked: false },
  [D]: { _id: D, email: 'dele@example.com', fullname: 'Dele', isGoogleLinked: true, googleRefreshToken: 'rt-d' },
};

// The instants this run works from. Derived from the sessions the pure helper
// resolves, so the script does not depend on which zone the platform is set to.
const [SESSION] = occurrences.sessionOccurrences(COURSE);
const APPOINTMENT_SESSION = occurrences.appointmentOccurrence(APPOINTMENT);
const at = (minutesBefore) => new Date(SESSION.start.getTime() - minutesBefore * 60000);
const atAppointment = (minutesBefore) =>
  new Date(APPOINTMENT_SESSION.start.getTime() - minutesBefore * 60000);

// --- the substitutions -------------------------------------------------------

const emails = [];
const notifications = [];
const emitted = [];
const calendarCreated = [];
const calendarPatched = [];
const claims = new Set();

require('../utils/sendEmailReminder.js').sendEmailReminder = async (to, message, type) => {
  emails.push({ to, message, type });
};

const google = require('../utils/googleCalendarReminders.js');
google.createSessionEvent = async (user, payload) => {
  calendarCreated.push({ email: user.email, ...payload });
  return { success: true, calendarEventId: `created-${calendarCreated.length}` };
};
google.applySessionReminders = async (user, calendarEventId) => {
  calendarPatched.push({ email: user.email, calendarEventId });
  return { success: true };
};

const chain = (records) => ({
  limit: () => chain(records),
  populate: () => chain(records),
  lean: async () => records,
});

require('../models/courses.js').find = () => chain([COURSE]);
require('../models/event.js').find = () => chain([]);
require('../models/appointment.js').find = () => chain([APPOINTMENT]);

require('../models/user.js').findById = (id) => ({
  select: async () => USERS[String(id)] || null,
});

require('../models/notifications.js').create = async (doc) => {
  notifications.push(doc);
  return doc;
};

// The real index is what makes a delivery once-only, so the stand-in has to
// enforce it in the same way: a second insert of the same key is a duplicate-key
// error, which is the signal the service reads.
require('../models/reminderDispatch.js').create = async (doc) => {
  const key = `${doc.kind}|${doc.occurrenceId}|${doc.offset}|${doc.userId}`;
  if (claims.has(key)) {
    const error = new Error('E11000 duplicate key error');
    error.code = 11000;
    throw error;
  }
  claims.add(key);
  return doc;
};

const sweep = require('../services/sessionReminderService.js');

const io = {
  to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
};

const snapshot = () => ({
  emails: emails.length,
  notifications: notifications.length,
  emitted: emitted.length,
  created: calendarCreated.length,
  patched: calendarPatched.length,
});

let failed = 0;

async function check(name, run) {
  try {
    const problems = (await run()) || [];
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

async function main() {
  console.log(`platform timezone: ${occurrences.platformTimezone()}`);
  console.log(`session: ${SESSION.start.toISOString()} (${DAY} ${DAY_NAME} 09:00)\n`);

  let baseline = snapshot();

  await check('the 30-minute reminder reaches every recipient, over all three channels', async () => {
    const problems = [];
    await sweep.sweepOnce({ io, now: at(30) });
    const sent = snapshot();

    // The learner, the instructor and the assigned tutor — and the appointment
    // is hours away, so nothing here is its.
    expect(problems, sent.emails - baseline.emails, 3, 'emails');
    expect(problems, sent.notifications - baseline.notifications, 3, 'notifications');
    expect(problems, sent.emitted - baseline.emitted, 3, 'popups');

    const latest = emails.slice(baseline.emails);
    if (!latest.every((mail) => mail.message.includes('in 30 minutes'))) {
      problems.push(`an email does not name the offset: ${latest.map((m) => m.message).join(' | ')}`);
    }
    if (!latest.every((mail) => mail.type === 'Class reminder')) {
      problems.push('an email subject is not the class reminder type');
    }
    return problems;
  });

  await check('the popup is addressed to the room of the person it concerns', async () => {
    const problems = [];
    const rooms = emitted.map((entry) => entry.room).sort().join(',');
    if (rooms !== [`user:${A}`, `user:${B}`, `user:${C}`].sort().join(',')) {
      problems.push(`rooms: ${rooms}`);
    }
    if (!emitted.every((entry) => entry.event === 'session_reminder')) {
      problems.push('a popup went out on the wrong event name');
    }
    return problems;
  });

  await check('the instructor\'s own calendar entry is patched, not duplicated', async () => {
    const problems = [];
    expect(problems, calendarCreated.length, 1, 'created');
    expect(problems, calendarCreated[0].email, USERS[A].email, 'created for');
    expect(problems, calendarPatched.length, 1, 'patched');
    expect(problems, calendarPatched[0].email, USERS[B].email, 'patched for');
    expect(problems, calendarPatched[0].calendarEventId, COURSE.calendarEventId, 'patched entry');
    return problems;
  });

  await check('a learner\'s calendar entry repeats the series rather than one session', async () => {
    const problems = [];
    const entry = calendarCreated[0];
    if (!entry) return ['nothing was created'];
    if (!String(entry.summary).includes('Intro to Python')) problems.push('entry is untitled');
    if (!String(entry.recurrence || '').includes('FREQ=WEEKLY')) problems.push('entry does not repeat');
    if (!entry.start || !entry.end) problems.push('entry has no window');
    return problems;
  });

  await check('a recipient with no linked calendar is still told in the app and by email', async () => {
    const problems = [];
    if (calendarCreated.some((entry) => entry.email === USERS[C].email)) {
      problems.push('a calendar entry was created for an account with no linked calendar');
    }
    if (!emails.some((mail) => mail.to === USERS[C].email)) {
      problems.push('the unlinked recipient was not emailed');
    }
    return problems;
  });

  baseline = snapshot();

  await check('a sweep at the same minute sends nothing a second time', async () => {
    const problems = [];
    await sweep.sweepOnce({ io, now: at(30) });
    const sent = snapshot();
    ['emails', 'notifications', 'emitted', 'created', 'patched'].forEach((channel) => {
      expect(problems, sent[channel] - baseline[channel], 0, channel);
    });
    return problems;
  });

  await check('a delayed sweep still inside the window sends nothing a second time', async () => {
    const problems = [];
    // Twenty minutes before the session the 30-minute reminder was due ten
    // minutes ago and is still within its catch-up window.
    await sweep.sweepOnce({ io, now: at(20) });
    const sent = snapshot();
    ['emails', 'notifications', 'emitted', 'created', 'patched'].forEach((channel) => {
      expect(problems, sent[channel] - baseline[channel], 0, channel);
    });
    return problems;
  });

  await check('a sweep past the window and before the next offset sends nothing', async () => {
    const problems = [];
    await sweep.sweepOnce({ io, now: at(14) });
    const sent = snapshot();
    ['emails', 'notifications', 'emitted'].forEach((channel) => {
      expect(problems, sent[channel] - baseline[channel], 0, channel);
    });
    return problems;
  });

  await check('the session-start reminder still fires after the earlier one was sent', async () => {
    const problems = [];
    await sweep.sweepOnce({ io, now: at(0) });
    const sent = snapshot();

    expect(problems, sent.emails - baseline.emails, 3, 'emails');
    expect(problems, sent.notifications - baseline.notifications, 3, 'notifications');
    expect(problems, sent.emitted - baseline.emitted, 3, 'popups');

    // The series is already in everyone's calendar, so a later offset of the
    // same session adds no entries.
    expect(problems, sent.created - baseline.created, 0, 'created');
    expect(problems, sent.patched - baseline.patched, 0, 'patched');

    const latest = emails.slice(baseline.emails);
    if (!latest.some((mail) => mail.message.includes('is starting now'))) {
      problems.push('no email announces the session as starting');
    }
    return problems;
  });

  baseline = snapshot();

  await check('an appointment is reminded on its own schedule, not the class\'s', async () => {
    const problems = [];
    await sweep.sweepOnce({ io, now: atAppointment(30) });
    const sent = snapshot();

    // Both sides of the appointment, and nobody from the course, whose own
    // 30-minute reminder was hours ago.
    expect(problems, sent.emails - baseline.emails, 2, 'emails');
    expect(problems, sent.notifications - baseline.notifications, 2, 'notifications');
    if (!emails.slice(baseline.emails).every((mail) => mail.type === 'Appointment reminder')) {
      problems.push('a class reminder went out for the appointment window');
    }

    // An appointment is one session, so it is written into each party's calendar
    // once and patched onto nothing — and it goes in on the first offset, not
    // the last, so someone who books late still gets it.
    expect(problems, sent.created - baseline.created, 2, 'created');
    expect(problems, sent.patched - baseline.patched, 0, 'patched');

    // The entry has to be identifiable from the calendar alone. `bookAppointment`
    // never stores a title, so a summary built from `record.title` alone comes
    // out as the bare label "Appointment" — a block on someone's phone that says
    // nothing about who they are meeting, which is the whole difference between
    // this and a class entry carrying its course title.
    const entries = calendarCreated.slice(-2);
    const forAdaEntry = entries.find((entry) => entry.email === USERS[A].email);
    const forDeleEntry = entries.find((entry) => entry.email === USERS[D].email);

    if (!forAdaEntry || forAdaEntry.summary !== 'Appointment with Bola') {
      problems.push(`the host entry is not named for them: ${forAdaEntry?.summary}`);
    }
    if (!forDeleEntry || forDeleEntry.summary !== 'Appointment with Ada') {
      problems.push(`the guest entry is not named for them: ${forDeleEntry?.summary}`);
    }
    if (!forDeleEntry || !String(forDeleEntry.description).includes('Ada')) {
      problems.push('the guest entry does not say who it is with');
    }
    // Each side is named for the OTHER person. An entry carrying its own owner's
    // name would pass a looser check and be useless in a calendar.
    if (forAdaEntry && forAdaEntry.summary.includes('Ada')) {
      problems.push('the host entry names the host rather than the person they are meeting');
    }
    return problems;
  });

  baseline = snapshot();

  await check('the appointment\'s start reminder adds no second calendar entry', async () => {
    const problems = [];
    await sweep.sweepOnce({ io, now: atAppointment(0) });
    const sent = snapshot();

    expect(problems, sent.emails - baseline.emails, 2, 'emails');
    expect(problems, sent.emitted - baseline.emitted, 2, 'popups');
    expect(problems, sent.created - baseline.created, 0, 'created');
    expect(problems, sent.patched - baseline.patched, 0, 'patched');
    if (!emails.slice(baseline.emails).every((mail) => mail.type === 'Appointment reminder')) {
      problems.push('a class reminder went out for the appointment');
    }
    return problems;
  });

  await check('each side of an appointment is told about the other', async () => {
    const problems = [];
    const forAda = emails.find((mail) => mail.to === USERS[A].email && mail.type === 'Appointment reminder');
    const forDele = emails.find((mail) => mail.to === USERS[D].email && mail.type === 'Appointment reminder');

    if (!forAda || !forAda.message.includes('Bola')) problems.push('the host is not told who they are meeting');
    if (!forDele || !forDele.message.includes('Ada')) problems.push('the guest is not told who they are meeting');
    return problems;
  });

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log(`all checks passed (${claims.size} deliveries claimed)`);
}

main();
