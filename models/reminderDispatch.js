const mongoose = require('mongoose');

// How long a dispatch row is kept after the session it belongs to.
//
// The row's only job is to stop a second reminder for a reminder already sent,
// and the sweep never looks further back than the session it is reminding
// about. Sixty days is generous enough to inspect what went out for a session
// that has since passed, and the TTL is what keeps this collection from growing
// without bound — there is one row per recipient per offset per session, which
// is a lot of rows over a year and none of them are worth keeping forever.
const RETENTION_DAYS = 60;

/**
 * A reminder that has actually been delivered.
 *
 * ## Why this collection exists
 *
 * The sweep runs every five minutes against occurrences that are up to a day
 * away, so the same reminder is a candidate on hundreds of consecutive runs.
 * The window alone cannot deduplicate it: a sweep delayed past the 15-minute
 * window and one that arrives inside it look identical from the occurrence's
 * point of view, and a restart replays whatever the clock says. So delivery is
 * claimed rather than inferred — the row is inserted *first*, and the reminder
 * is sent only if that insert was the one that created it. The unique index is
 * the entire mechanism, which is why it is compound across every field that
 * makes a reminder distinct.
 *
 * ## Why `occurrenceId` carries the session's start
 *
 * A course with a weekly schedule is one record and many sessions. `occurrenceId`
 * is `course:<id>:<session start ISO>`, so Monday's session and Wednesday's are
 * different reminders, and a single session's five offsets share the id and are
 * told apart by `offset`. An id built from the record alone would send one
 * reminder for the first session and nothing for the rest of the term.
 *
 * ## Ordering, and what it costs
 *
 * Insert-then-send means a crash in between loses that one reminder; the
 * reverse order means a crash sends it again on the next sweep, and a duplicate
 * reminder to a learner is worse than a missing one — it is wrong in a way they
 * will report as a bug. Nothing here retries a failed channel for the same
 * reason: the row already exists by then, so the sweep will not come back to it.
 *
 * Nothing about the delivery itself is recorded, because nothing here would be
 * believed: a channel that failed is already in the server log, and a field
 * written after the send lands after the failure it would have described.
 */
const reminderDispatchSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['course', 'event', 'appointment'],
      required: true,
    },
    // `<kind>:<record id>:<session start ISO>`, or `<kind>:<record id>` for the
    // calendar entry, which is written once per series rather than per session.
    occurrenceId: { type: String, required: true },
    // A key from `REMINDER_OFFSETS`, or `calendar` — the same claim mechanism
    // guards the calendar write so a series is entered into someone's calendar
    // once, however many of its sessions pass through the sweep.
    offset: { type: String, required: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // The session this reminder is for, so the row expires relative to the
    // thing it is about rather than to when it happened to be written.
    startAt: { type: Date, required: true },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

reminderDispatchSchema.index(
  { kind: 1, occurrenceId: 1, offset: 1, userId: 1 },
  { unique: true },
);
reminderDispatchSchema.index({ startAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

const ReminderDispatch = mongoose.model('ReminderDispatch', reminderDispatchSchema);

module.exports = ReminderDispatch;
