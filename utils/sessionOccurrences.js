/**
 * When a scheduled session actually starts, and which reminder is due for it.
 *
 * Everything here is pure — no database, no mail, no clock of its own — so the
 * arithmetic that decides whether a reminder fires four hours or four days early
 * can be driven from `node -e` and checked directly. It is the part of the
 * reminder engine most likely to be wrong, and the part that is hardest to
 * notice: a reminder that fires at the wrong minute still looks like a reminder.
 *
 * ## Why the times are not simply parsed
 *
 * The platform stores session times as **wall-clock strings**, not instants:
 *
 *   - an appointment is `date: "2026-10-10"` plus `time: "09:00"`
 *   - a course or event is `startDate`/`endDate` (written as ISO by the browser,
 *     but read back only for their *date*) plus a weekly `days` schedule whose
 *     entries carry their own `startTime`/`endTime`
 *
 * `new Date("2026-10-10T09:00")` is interpreted in whatever timezone the process
 * happens to run in, so the same record resolves to different instants on a
 * developer's machine and on a UTC server — and the reminder fires at a different
 * minute on each. Nothing in the record says which timezone the author meant, so
 * one has to be chosen explicitly and used consistently: `PLATFORM_TIMEZONE`,
 * defaulting to `Africa/Lagos`, the market the times are authored in.
 *
 * The consequence, stated plainly: a learner whose own clock is set to another
 * timezone sees the session at a different wall-clock time than the reminder
 * fires at. That is already true of the calendar, which renders in the browser's
 * timezone, and it is not something this module can fix by guessing a third
 * timezone — the stored string has exactly one meaning, and this is it.
 *
 * ## The recurrence
 *
 * `days` matches the calendar's own expansion (`generateCourseEvents` in
 * `CalenderView.tsx`): a checked day whose name matches the weekday is a session,
 * walked from `startDate` to `endDate` inclusive. A record with no usable `days`
 * is a single session on `startDate` at the record's own `startTime` — including
 * when that is absent, which reads as midnight, exactly as the calendar's
 * no-schedule branch reads it. Mirroring that expansion exactly is deliberate: a
 * reminder must fire before the session the learner can see, not before a session
 * only this file believes in.
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TIMEZONE = 'Africa/Lagos';

/** The timezone wall-clock session times are authored in. */
function platformTimezone() {
  return process.env.PLATFORM_TIMEZONE || DEFAULT_TIMEZONE;
}

/**
 * The reminder points, in the order they fire.
 *
 * `minutes` is how long before the session starts; every offset is at least 30
 * minutes from the next, which is what lets `dueReminder` resolve at most one of
 * them for a given sweep without needing to order or compare them.
 */
const REMINDER_OFFSETS = [
  { key: '24h', minutes: 24 * 60, label: 'in 24 hours' },
  { key: '4h', minutes: 4 * 60, label: 'in 4 hours' },
  { key: '1h', minutes: 60, label: 'in 1 hour' },
  { key: '30m', minutes: 30, label: 'in 30 minutes' },
  { key: 'start', minutes: 0, label: 'starting now' },
];

/**
 * How late a reminder may still fire.
 *
 * The sweep runs every five minutes, so five would be the tight window — but a
 * sweep that is delayed (a slow query, a restart, a deploy) would then drop the
 * reminder entirely, and the person never learns the session moved. Fifteen
 * minutes absorbs that without ever overlapping the neighbouring offset, the
 * closest of which is thirty minutes away. A once-only record stops the wider
 * window from sending anything twice.
 */
const DUE_WINDOW_MINUTES = 15;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A clock string ("09:00", "9:05") as hours and minutes.
 *
 * Anything unparseable reads as midnight, matching how the calendar treats a
 * missing time. Guarded rather than thrown because a malformed time must not
 * take down a sweep that is also carrying other people's reminders.
 */
function parseClock(value) {
  const [rawHour = '0', rawMinute = '0'] = String(value ?? '').split(':');
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  return {
    hour: Number.isFinite(hour) ? Math.min(Math.max(Math.trunc(hour), 0), 23) : 0,
    minute: Number.isFinite(minute) ? Math.min(Math.max(Math.trunc(minute), 0), 59) : 0,
  };
}

/**
 * The calendar day a stored date value falls on, in the platform timezone.
 *
 * A bare "YYYY-MM-DD" is already that day. An ISO instant (what the browser
 * writes for `startDate`) is a real moment, so it is converted into the platform
 * timezone first — taking the date off the instant in the *server's* timezone
 * would name the wrong day for any session late enough in the evening.
 *
 * Returns null for anything unparseable, so a record with a broken date is
 * skipped rather than resolved to "now" and reminded for immediately.
 */
function platformDay(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (DATE_ONLY.test(raw)) {
    const parsed = dayjs.tz(raw, platformTimezone());
    return parsed.isValid() ? parsed : null;
  }

  const parsed = dayjs(raw);
  return parsed.isValid() ? dayjs(parsed.toDate()).tz(platformTimezone()) : null;
}

/**
 * A day plus a wall-clock time, as an exact instant.
 *
 * The setter runs on the timezone-aware value, so it moves the clock *in the
 * platform timezone* and leaves the offset alone — 09:00 means 09:00 in Lagos
 * whether or not the server has ever heard of Lagos.
 */
function atClock(day, timeValue) {
  if (!day) return null;
  const { hour, minute } = parseClock(timeValue);
  return day.hour(hour).minute(minute).second(0).millisecond(0);
}

/**
 * Every session a course or event record describes, as exact instants.
 *
 * Returns `[{ start, end }]` with `end` null when the record carries no usable
 * end time. Both are Date objects, so the caller can compare them with `now`
 * without knowing anything about how the record stores its schedule.
 */
function sessionOccurrences(record) {
  if (!record) return [];

  const firstDay = platformDay(record.startDate);
  if (!firstDay) return [];

  const schedule = (Array.isArray(record.days) ? record.days : [])
    .filter((day) => day && day.checked && day.startTime && day.endTime);

  if (!schedule.length) {
    const start = atClock(firstDay, record.startTime);
    return start ? [{ start: start.toDate(), end: null }] : [];
  }

  const lastDay = platformDay(record.endDate) || firstDay;
  const occurrences = [];

  // Walked by calendar day, exactly as the calendar view walks it, so the two
  // can never disagree about which days the session runs on.
  for (let day = firstDay.startOf('day'); !day.isAfter(lastDay, 'day'); day = day.add(1, 'day')) {
    const name = day.format('dddd');
    const entry = schedule.find((slot) => slot.day === name);
    if (!entry) continue;

    const start = atClock(day, entry.startTime);
    if (!start) continue;

    const end = atClock(day, entry.endTime);
    occurrences.push({ start: start.toDate(), end: end ? end.toDate() : null });
  }

  return occurrences;
}

/**
 * Every session an appointment describes — always exactly one, or none.
 *
 * An appointment's time lives in two places. `time` is what the booking form
 * writes and what the calendar reads; `startTime` is the precise window added
 * for the calendar screens and is preferred when present, because a row that has
 * one was written by newer code that meant it. Falling back to `time` keeps
 * every appointment booked before that field existed reminding correctly.
 */
function appointmentOccurrence(appointment) {
  if (!appointment) return null;

  const day = platformDay(appointment.date);
  if (!day) return null;

  const start = atClock(day, appointment.startTime || appointment.time);
  if (!start) return null;

  const end = appointment.endTime ? atClock(day, appointment.endTime) : null;
  return { start: start.toDate(), end: end ? end.toDate() : null };
}

/**
 * Which reminder, if any, is due for a session starting at `start`.
 *
 * A reminder for an offset is due once the clock has reached its firing time and
 * has not yet left the window. Because the offsets are more than a window apart,
 * at most one can ever match, so the answer needs no tie-break.
 *
 * Only offsets whose firing time is in the past are considered: a sweep that
 * runs early must not announce a session as starting in an hour when it starts
 * in an hour and four minutes.
 */
function dueReminder(start, now = new Date(), windowMinutes = DUE_WINDOW_MINUTES) {
  const startMs = start instanceof Date ? start.getTime() : new Date(start).getTime();
  if (!Number.isFinite(startMs)) return null;

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;

  const windowMs = windowMinutes * 60000;

  for (const offset of REMINDER_OFFSETS) {
    const firesAt = startMs - offset.minutes * 60000;
    if (nowMs >= firesAt && nowMs < firesAt + windowMs) return offset;
  }

  return null;
}

/** The latest instant a reminder can still be looked for, used to bound the query. */
function furthestLookaheadMinutes() {
  return REMINDER_OFFSETS[0].minutes + DUE_WINDOW_MINUTES;
}

/**
 * "in 30 minutes" / "in 1 hour" / "in 24 hours", as a sentence fragment.
 *
 * The last offset is the session itself, which reads oddly as "in 0 minutes", so
 * it is named for what it is.
 */
function offsetPhrase(offset) {
  return offset?.label || 'soon';
}

module.exports = {
  DEFAULT_TIMEZONE,
  DUE_WINDOW_MINUTES,
  REMINDER_OFFSETS,
  platformTimezone,
  parseClock,
  platformDay,
  atClock,
  sessionOccurrences,
  appointmentOccurrence,
  dueReminder,
  furthestLookaheadMinutes,
  offsetPhrase,
};
