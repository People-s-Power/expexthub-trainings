const cron = require('node-cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

const Course = require('../models/courses');
const LearningEvent = require('../models/event');
const Appointment = require('../models/appointment');
const User = require('../models/user');
const Notification = require('../models/notifications');
const ReminderDispatch = require('../models/reminderDispatch');

const { sendEmailReminder } = require('../utils/sendEmailReminder');
const {
  platformDay,
  platformTimezone,
  sessionOccurrences,
  appointmentOccurrence,
  dueReminder,
  furthestLookaheadMinutes,
  offsetPhrase,
} = require('../utils/sessionOccurrences');
const {
  DAY_CODES,
  canWriteCalendar,
  applySessionReminders,
  createSessionEvent,
} = require('../utils/googleCalendarReminders');

dayjs.extend(utc);
dayjs.extend(timezone);

// Reminders for classes and appointments, at 24 hours, 4 hours, 1 hour and 30
// minutes before they start and again as they start.
//
// ## Why a sweep and not five timers
//
// Five scheduled jobs, one per offset, each asking "what starts in exactly N
// minutes" is the shape this replaced (`utils/ReminderSetupEmail.js`), and it
// was wrong in a way that is easy to miss: a job that runs at 09:00 asking for
// sessions starting at 10:00 never fires for a session created at 09:30, and a
// job that runs twice, or runs late, either misses the session or announces it
// twice. One sweep that asks "what is due now" has neither problem — being late
// is handled by the catch-up window, and being early by only ever considering
// offsets whose firing minute has passed.
//
// The five offsets are not five queries. `dueReminder` resolves at most one of
// them for a given session at a given minute, so a single pass over the sessions
// in range covers all five, and the ones that are not due yet become due on a
// later pass over the same session.
//
// ## Who is told
//
// Whoever has to be there: everyone enrolled or booked in, plus the instructor
// and the tutors assigned to deliver it. For an appointment, both parties.
//
// ## What is not re-derived here
//
// When a session starts — the weekly recurrence, the wall-clock strings, the
// platform timezone — is `utils/sessionOccurrences.js`, which is pure and
// checked on its own by `scripts/sessionOccurrences.check.js`. Nothing about
// scheduling is decided in this file; it decides who to tell and how.
//
// ## The three channels
//
// In-app (a `Notification` row plus the socket event that makes it appear
// without a refresh), email, and Google Calendar. Each is attempted
// independently and none can stop the others: a learner with no email address
// on file still gets the popup, and a calendar Google refuses still leaves them
// the email. The Google writes live in `utils/googleCalendarReminders.js`.

// A hard ceiling on how many records one source may contribute to a pass. The
// sweep asks for everything that has already started and has not yet finished,
// which on a mature platform is most of the catalogue; this bounds the work a
// single pass can do so a full table cannot turn into a sweep that never ends
// and therefore never releases the overlap guard. Set far above any plausible
// number of live classes.
const MAX_RECORDS_PER_SOURCE = 500;

// How long a session is assumed to run when the record does not say. Google
// will not accept an entry whose end is not after its start, and a course with
// no per-day schedule genuinely has no end time to offer.
const ASSUMED_DURATION_MINUTES = 60;

const SOURCES = [
  {
    kind: 'course',
    model: Course,
    label: 'Class',
    // A course is in range while it could still have a session in the window:
    // it starts no later than two days out (the furthest a 24-hour reminder can
    // reach), and it has not already finished. `startDate`/`endDate` are
    // compared as strings, which is how they are stored and how ISO-shaped and
    // bare `YYYY-MM-DD` values both order correctly.
    query: (fromDay, toBound) => ({
      startDate: { $lte: toBound },
      $or: [
        { endDate: { $gte: fromDay } },
        { endDate: { $in: [null, ''] } },
        { endDate: { $exists: false } },
      ],
    }),
    occurrences: (record) => sessionOccurrences(record),
  },
  {
    kind: 'event',
    model: LearningEvent,
    label: 'Event',
    query: (fromDay, toBound) => ({
      startDate: { $lte: toBound },
      $or: [
        { endDate: { $gte: fromDay } },
        { endDate: { $in: [null, ''] } },
        { endDate: { $exists: false } },
      ],
    }),
    occurrences: (record) => sessionOccurrences(record),
  },
  {
    kind: 'appointment',
    model: Appointment,
    label: 'Appointment',
    // `date` is a plain `YYYY-MM-DD` day on every row the booking form writes,
    // so a range over it is a range over days. A cancelled appointment is not
    // worth reminding anyone about; the field defaults to `pending`, and rows
    // that predate it match `$ne` too.
    query: (fromDay, toBound) => ({
      date: { $gte: fromDay, $lte: toBound },
      status: { $ne: 'cancelled' },
    }),
    populate: [['from', 'fullname'], ['to', 'fullname']],
    occurrences: (record) => {
      const single = appointmentOccurrence(record);
      return single ? [single] : [];
    },
  },
];

/** `<kind>:<record id>:<session start>`, the identity of one session. */
function occurrenceKey(kind, id, start) {
  const base = `${kind}:${String(id)}`;
  return start ? `${base}:${new Date(start).toISOString()}` : base;
}

/** A stored reference as a plain id string, whether populated or not. */
function idOf(value) {
  if (!value) return null;
  const raw = value._id || value;
  const id = String(raw);
  return /^[a-f\d]{24}$/i.test(id) ? id : null;
}

/**
 * Everyone who should be told about a session.
 *
 * The tutor is included alongside the learners: they are the one who has to be
 * in the room, and a provider teaching three courses in a day should be
 * reminded about all three. Deduplicated, because an instructor is routinely
 * also one of the assigned tutors, and reminded twice is how a reminder starts
 * being ignored.
 */
function reminderAudience(record, kind) {
  if (!record) return [];

  const ids = [];
  const add = (value) => {
    const id = idOf(value);
    if (id) ids.push(id);
  };

  if (kind === 'appointment') {
    add(record.from);
    add(record.to);
  } else {
    (record.enrolledStudents || []).forEach(add);
    (record.enrollments || []).forEach((enrolment) => add(enrolment && enrolment.user));
    add(record.instructorId);
    add(record.authorId);
    (record.assignedTutors || []).forEach(add);
  }

  return [...new Set(ids)];
}

/**
 * What to say, for one recipient.
 *
 * The recipient is needed as well as the session because an appointment has two
 * sides and a reminder that does not name the other one is barely a reminder.
 */
function reminderCopy(kind, record, occurrence, offset, recipientId) {
  const source = SOURCES.find((entry) => entry.kind === kind);
  const label = source ? source.label : 'Session';

  let name = record.title || label;
  if (kind === 'appointment') {
    const from = idOf(record.from);
    const to = idOf(record.to);
    // Each side is told about the other: "appointment with Ada" is a reminder,
    // "Appointment in 30 minutes" is a notification nobody can act on.
    const counterpart = recipientId && from === recipientId ? record.to : record.from;
    const other = counterpart && counterpart.fullname;
    name = other
      ? `${record.title ? `${record.title} — ` : ''}appointment with ${other}`
      : record.title || 'Appointment';
  }

  const when = dayjs(occurrence.start)
    .tz(platformTimezone())
    .format('ddd, D MMM YYYY [at] HH:mm');
  const timing = offsetPhrase(offset);
  const zone = platformTimezone();

  return {
    title: offset.minutes === 0 ? `${label} starting now` : `${label} ${timing}`,
    content: `${name} — ${when} (${zone})`,
    // `sendEmailReminder` builds its own subject as "<type> from ExpertHub", so
    // the type is the whole subject this channel can control.
    emailType: `${label} reminder`,
    emailBody:
      `${offset.minutes === 0 ? `${label} is starting now` : `${label} starts ${timing}`}. ` +
      `${name} — ${when} (${zone}).`,
  };
}

/**
 * The weekly rule that turns one session into the whole series.
 *
 * Only for records with a real schedule, because a rule is only worth writing
 * when there is more than one session to repeat — and because Google rejects a
 * rule whose `UNTIL` precedes its start, which is what a course whose last day
 * has passed would produce.
 *
 * The last day is taken in the platform timezone rather than the server's: a
 * server running ahead of Lagos would otherwise end the series at an instant
 * that falls before the final evening session it is meant to cover.
 */
function seriesRecurrence(record, kind, nextStart) {
  if (kind === 'appointment') return null;

  const schedule = (Array.isArray(record.days) ? record.days : []).filter(
    (day) => day && day.checked && day.startTime && day.endTime,
  );
  const codes = [...new Set(schedule.map((day) => DAY_CODES[day.day]).filter(Boolean))];
  if (!codes.length) return null;

  const lastDay = platformDay(record.endDate);
  if (!lastDay) return null;

  const until = lastDay.endOf('day');
  if (!until.isAfter(dayjs(nextStart))) return null;

  return `RRULE:FREQ=WEEKLY;BYDAY=${codes.join(',')};UNTIL=${until.utc().format('YYYYMMDDTHHmmss[Z]')}`;
}

/**
 * Take the claim on one delivery, exactly once.
 *
 * True means this call is the one that created the row and the reminder has not
 * been sent; false means somebody already sent it. See the model for why the
 * insert is what decides.
 */
async function claim({ kind, occurrenceId, offset, userId, startAt }) {
  try {
    await ReminderDispatch.create({ kind, occurrenceId, offset, userId, startAt });
    return true;
  } catch (error) {
    if (error && error.code === 11000) return false;
    throw error;
  }
}

/** The popup, and the socket event that saves the reader a refresh. */
async function notifyInApp({ io, userId, record, copy, occurrence, kind, offset }) {
  try {
    await Notification.create({
      title: copy.title,
      content: copy.content,
      contentId: record._id,
      read: false,
      userId,
    });
  } catch (error) {
    console.error('Reminder notification failed:', error.message);
  }

  try {
    io?.to(`user:${userId}`).emit('session_reminder', {
      kind,
      recordId: String(record._id),
      offset: offset.key,
      title: copy.title,
      content: copy.content,
      startAt: occurrence.start.toISOString(),
    });
  } catch (error) {
    console.error('Reminder socket emit failed:', error.message);
  }
}

async function notifyByEmail({ user, copy }) {
  if (!user.email) return;
  try {
    await sendEmailReminder(user.email, copy.emailBody, copy.emailType);
  } catch (error) {
    console.error(`Reminder email to ${user.email} failed:`, error.message);
  }
}

/**
 * Put the session on the recipient's own Google Calendar, once per series.
 *
 * The host already has an entry — `createGoogleMeet` made it when the course or
 * event was published — so theirs is patched with the reminder times instead of
 * duplicated. Everyone else gets an entry of their own, which is the only way a
 * learner's linked calendar can show a class they are enrolled in.
 *
 * Claimed under its own `calendar` offset so a series is written once however
 * many of its sessions pass through the sweep: without that, a course running
 * twice a week for three months would be entered into someone's calendar
 * twenty-four times.
 */
async function writeCalendar({ source, record, occurrence, userId, user }) {
  if (!canWriteCalendar(user)) return;
  if (!(await claim({
    kind: source.kind,
    occurrenceId: occurrenceKey(source.kind, record._id),
    offset: 'calendar',
    userId,
    startAt: occurrence.start,
  }))) return;

  const hostId =
    idOf(record.instructorId) || idOf(record.authorId);
  const calendarEventId = record.calendarEventId;

  if (hostId === userId && calendarEventId) {
    await applySessionReminders(user, calendarEventId);
    return;
  }

  const start = occurrence.start;
  const end = occurrence.end || new Date(start.getTime() + ASSUMED_DURATION_MINUTES * 60000);

  await createSessionEvent(user, {
    summary: record.title || source.label,
    description: record.about || `${source.label} on ExpertHub`,
    start,
    end,
    recurrence: seriesRecurrence(record, source.kind, start),
  });
}

/** Tell everyone who has to be there about one due session. */
async function deliver({ source, record, occurrence, offset, io }) {
  const startAt = occurrence.start;
  const sessionId = occurrenceKey(source.kind, record._id, startAt);

  for (const userId of reminderAudience(record, source.kind)) {
    // Claimed before the recipient is even loaded, so the repeated passes over
    // an already-announced session cost one failed insert each and nothing else.
    const first = await claim({
      kind: source.kind,
      occurrenceId: sessionId,
      offset: offset.key,
      userId,
      startAt,
    });
    if (!first) continue;

    const user = await User.findById(userId).select(
      'email fullname gMail isGoogleLinked googleAccessToken googleRefreshToken',
    );
    if (!user) continue;

    const copy = reminderCopy(source.kind, record, occurrence, offset, userId);
    await notifyInApp({ io, userId, record, copy, occurrence, kind: source.kind, offset });
    await notifyByEmail({ user, copy });
    await writeCalendar({ source, record, occurrence, userId, user });
  }
}

/**
 * One pass: everything due to be reminded about, right now.
 *
 * Exported so it can be driven directly — the scheduling below is five lines
 * and the logic worth checking is all here.
 */
async function sweepOnce({ io, now = new Date() } = {}) {
  const today = platformDay(now);
  const summary = { examined: 0, reminders: 0 };
  if (!today) return summary;

  // Two days out is where the furthest reminder can reach, plus a day of slack
  // behind for a record that is running now and started yesterday.
  const fromDay = today.subtract(1, 'day').format('YYYY-MM-DD');
  const toBound = `${today.add(2, 'day').format('YYYY-MM-DD')}T23:59:59.999Z`;

  for (const source of SOURCES) {
    let query = source.model.find(source.query(fromDay, toBound)).limit(MAX_RECORDS_PER_SOURCE);
    (source.populate || []).forEach(([path, select]) => {
      query = query.populate(path, select);
    });

    const records = await query.lean();
    summary.examined += records.length;

    if (records.length === MAX_RECORDS_PER_SOURCE) {
      console.warn(
        `[reminders] ${source.kind} hit the ${MAX_RECORDS_PER_SOURCE}-record ceiling for one pass`,
      );
    }

    for (const record of records) {
      for (const occurrence of source.occurrences(record)) {
        const offset = dueReminder(occurrence.start, now);
        if (!offset) continue;

        summary.reminders += 1;
        await deliver({ source, record, occurrence, offset, io });
      }
    }
  }

  return summary;
}

/**
 * Run the sweep every five minutes.
 *
 * Five minutes against a fifteen-minute catch-up window means a pass that is
 * slow, delayed by a deploy, or skipped by a restart still leaves the offset
 * reachable on the next one.
 */
function startSessionReminderSweep(io) {
  // A pass that overruns its own interval must not have a second one start on
  // top of it: two passes racing over the same session would both be sending
  // the reminders the claim has not yet recorded.
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { examined, reminders } = await sweepOnce({ io });
      if (reminders) {
        console.log(`[reminders] ${reminders} session(s) due across ${examined} record(s)`);
      }
    } catch (error) {
      console.error('Reminder sweep failed:', error);
    } finally {
      running = false;
    }
  };

  cron.schedule('*/5 * * * *', run);
  console.log(
    `[reminders] sweep scheduled every 5 minutes (window ${furthestLookaheadMinutes()} minutes)`,
  );

  return run;
}

module.exports = {
  ASSUMED_DURATION_MINUTES,
  SOURCES,
  occurrenceKey,
  reminderAudience,
  reminderCopy,
  seriesRecurrence,
  sweepOnce,
  startSessionReminderSweep,
};
