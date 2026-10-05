const axios = require('axios').default;

// Google Calendar writes for session reminders.
//
// Deliberately separate from `createGoogleMeeting.js`, which creates the Meet
// link and the host's calendar entry when a course or event is published. This
// module is only ever called from the reminder sweep, and every call is
// non-fatal there: a calendar that refuses a write must not cost anybody their
// in-app or emailed reminder, and must never fail the request that created the
// course. Keeping the writes here rather than inside event creation is what
// makes that true — a rejected `reminders` object would otherwise take the
// whole course-creation call down with it.
//
// There is no `googleapis` dependency in this project, so this speaks the REST
// API directly with axios, refreshing through the same OAuth endpoint and the
// same refresh-on-401 shape as `createGoogleMeeting.js`.

const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// The five points the platform reminds people at, expressed the way Google
// wants them: minutes before the start, as popups.
//
// These are the same five offsets the sweep announces through the app and by
// email (`REMINDER_OFFSETS` in `utils/sessionOccurrences.js`), and they are set
// on the calendar entry rather than pushed one at a time because Google then
// owns the timing. A reminder that arrives while this server is deploying,
// asleep, or simply not running is still a reminder.
//
// Five is Google's documented maximum for `reminders.overrides`, so this list
// cannot grow without one of the five moving to a different mechanism.
const REMINDER_OVERRIDES = [
  { method: 'popup', minutes: 24 * 60 },
  { method: 'popup', minutes: 4 * 60 },
  { method: 'popup', minutes: 60 },
  { method: 'popup', minutes: 30 },
  { method: 'popup', minutes: 0 },
];

const REMINDERS = { useDefault: false, overrides: REMINDER_OVERRIDES };

const DAY_CODES = {
  Monday: 'MO',
  Tuesday: 'TU',
  Wednesday: 'WE',
  Thursday: 'TH',
  Friday: 'FR',
  Saturday: 'SA',
  Sunday: 'SU',
};

/** Whether this account can be written to without a human in the loop. */
function canWriteCalendar(user) {
  return Boolean(user && user.isGoogleLinked && user.googleRefreshToken);
}

/**
 * A usable access token, refreshed and saved when the stored one is spent.
 *
 * Google reports an expired token as a 401 and nothing else, so the caller's
 * only sensible move is to refresh and try once more — which is what
 * `request()` below does, rather than every caller repeating it.
 */
async function refreshAccessToken(user) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: user.googleRefreshToken,
    grant_type: 'refresh_token',
  });

  const { data } = await axios.post('https://oauth2.googleapis.com/token', params);
  user.googleAccessToken = data.access_token;
  // Saved so the next caller (and the Meet-link path) starts with a live token
  // instead of refreshing for itself and invalidating this one.
  await user.save();
  return data.access_token;
}

/**
 * One authenticated call, retried once against a refreshed token.
 *
 * The 401 path mirrors `createGoogleMeet`: only a token error is worth a
 * retry, so a 403 (the account revoked access) or a 400 (a malformed body) is
 * reported to the caller rather than refreshed into a second identical failure.
 */
async function request(user, run) {
  try {
    return await run(user.googleAccessToken);
  } catch (error) {
    if (error.response?.status !== 401) throw error;
    const accessToken = await refreshAccessToken(user);
    return run(accessToken);
  }
}

/**
 * Put the five reminder popups on a calendar entry that already exists.
 *
 * Used for the entry `createGoogleMeet` made for the host when the course or
 * event was published. It is a patch rather than part of that original create
 * for the reason given at the top of this file.
 */
async function applySessionReminders(user, calendarEventId) {
  if (!canWriteCalendar(user) || !calendarEventId) {
    return { success: false, message: 'Google account not linked' };
  }

  try {
    await request(user, (accessToken) =>
      axios.patch(
        `${CALENDAR_EVENTS}/${encodeURIComponent(calendarEventId)}`,
        { reminders: REMINDERS },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      ),
    );
    return { success: true };
  } catch (error) {
    console.error(
      'Applying session reminders failed:',
      error.response?.data || error.message,
    );
    return { success: false, message: 'Failed to set calendar reminders' };
  }
}

/**
 * Write a session onto someone's own calendar, with the five reminders on it.
 *
 * This is how a learner's linked calendar learns about their classes. The entry
 * is created once per series and carries a weekly recurrence, so a course that
 * runs for three months is one entry that pops five times per session rather
 * than three dozen entries — and Google keeps the timing, per the note on
 * `REMINDER_OVERRIDES`.
 *
 * `recurrence` is optional and already fully formed; see `seriesRecurrence`.
 */
async function createSessionEvent(user, { summary, description, start, end, recurrence }) {
  if (!canWriteCalendar(user)) {
    return { success: false, message: 'Google account not linked' };
  }

  const body = {
    summary,
    description,
    start: { dateTime: new Date(start).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(end).toISOString(), timeZone: 'UTC' },
    ...(recurrence ? { recurrence: [recurrence] } : {}),
    reminders: REMINDERS,
  };

  try {
    const res = await request(user, (accessToken) =>
      axios.post(CALENDAR_EVENTS, body, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      }),
    );
    return { success: true, calendarEventId: res.data?.id };
  } catch (error) {
    console.error(
      'Creating session calendar entry failed:',
      error.response?.data || error.message,
    );
    return { success: false, message: 'Failed to create calendar entry' };
  }
}

module.exports = {
  DAY_CODES,
  REMINDER_OVERRIDES,
  canWriteCalendar,
  refreshAccessToken,
  applySessionReminders,
  createSessionEvent,
};
