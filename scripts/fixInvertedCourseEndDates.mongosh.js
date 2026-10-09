/**
 * One-off repair: courses whose end date falls before their own start date.
 * **mongosh edition** — paste into the shell inside MongoDB Compass.
 *
 * A course stored that way runs on no days at all. The calendar walks
 * `startDate → endDate` a day at a time, so its loop never executes; the reminder
 * engine asks the same range the same question (utils/sessionOccurrences.js) and
 * finds no sessions either. Nothing errors, and the course keeps its place on the
 * dashboard and the courses screen — which is exactly what makes the failure
 * quiet. It looks scheduled everywhere except the two places that act on it.
 *
 * Found in production as three courses of one provider, each ending in the
 * January *before* its own start (Jul/Oct 2026 → Jan 2026): the shape left by a
 * date picker when the year is not moved forward along with the month.
 *
 * The repair adds one year to the end date, and only where doing so actually
 * moves it to or after the start. Where a year does not resolve the inversion —
 * or where the two dates are less than three months apart, so the year is not
 * the plausible mistake — the row is printed and left alone. Nothing here can
 * tell a wrong year from a wrong month, so the case a year cannot explain is a
 * case for a person. Read the dry run before trusting it for that reason.
 *
 * This is the same rule as scripts/fixInvertedCourseEndDates.js, which needs
 * DB_USERNAME/DB_PASSWORD and could not be run on the machine that found the
 * rows. Two copies of one rule drift, so they are written to be read side by
 * side, and they differ in exactly one place, deliberately: a date string this
 * script cannot read is reported and skipped, where the Node one rewrote it as
 * ISO. Every stored shape this database actually holds is the plain ISO string
 * the API writes, so the case never arises; if it ever does, a person should see
 * it rather than have a formatter guess at it.
 *
 * HOW TO RUN
 *   1. In Compass, connect and select the database that holds `courses`. The
 *      script uses whatever database the shell is pointing at and prints its
 *      name first — check that line before reading anything else.
 *   2. Open the embedded shell and paste this whole file.
 *   3. Read the dry run. APPLY is false, so it writes nothing.
 *   4. Set APPLY = true and paste it again. Running it twice is harmless: a
 *      repaired row is no longer inverted, so the second pass finds nothing.
 *
 * Copy this text from the file itself, and run it — do not retype it and do not
 * route it through anything that renders text. A view that reads dollar pairs as
 * maths strips the dollar signs out of the template literals above, and a date
 * built from a stripped template is text, not a date. The script refuses to
 * write one (see asDate below), but the rows already carrying such text are a
 * repair in their own right.
 */

const APPLY = false; // flip to true only after reading the dry run
const YEAR_SCALE_GAP_MONTHS = 3;

// The shape the API writes, with or without a time and a zone suffix. Only the
// date part is read: ExpertHub's sessions are wall-clock, so the range a course
// spans is the calendar dates as written, not the instants they denote.
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})(.*)$/;

/**
 * Read the date part of a stored string. Returns null for anything else — a
 * BSON Date, a missing field, a shape from an older form, or a day that does
 * not exist (`2026-02-31`), which `new Date` would silently roll forward.
 */
function readDate(value) {
  if (typeof value !== 'string') return null;
  const match = SHAPE.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return { y: y, mo: mo, d: d, rest: match[4], raw: value };
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (p) => p.y * 10000 + p.mo * 100 + p.d;
const render = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}${p.rest}`;

/**
 * `2026-01-11T13:00:00.000Z` → `2027-01-11T13:00:00.000Z`, keeping the stored
 * shape so the time of day and any suffix survive untouched. `Date.UTC`
 * normalises 29 February to 1 March, which is the only honest reading of "a
 * year later" for a day that has no counterpart in the new year.
 */
function oneYearLater(p) {
  const rolled = new Date(Date.UTC(p.y + 1, p.mo - 1, p.d));
  return {
    y: rolled.getUTCFullYear(),
    mo: rolled.getUTCMonth() + 1,
    d: rolled.getUTCDate(),
    rest: p.rest,
    raw: p.raw,
  };
}

/**
 * What is about to be written has to be a date.
 *
 * This script builds the new value by hand, and a hand-built value can arrive
 * here mangled. A template literal loses its dollar signs when the text is
 * copied out of a view that renders dollar pairs as maths — the braces beside
 * them go too, because LaTeX reads braces as grouping — and what lands in
 * endDate is then text that no reader understands: no calendar events, no
 * reminders, nothing reported. That has happened to rows in this database, so
 * the value is checked before the write rather than after.
 */
function asDate(text, context) {
  if (!readDate(text)) {
    throw new Error(
      'refusing to write ' + JSON.stringify(text) + ' as an end date (' + context + '): ' +
        'that is not a date. Re-copy this script from the file in the repository and run it again.',
    );
  }
  return text;
}

/** How far the end date sits before the start, in months, as a rough decimal. */
function gapMonths(start, end) {
  return (start.y - end.y) * 12 + (start.mo - end.mo) + (start.d - end.d) / 31;
}

/** The weekly slots a course claims, for the follow-up check below. */
function badSlots(course) {
  return (course.days || []).filter(function (slot) {
    if (!slot || !slot.checked) return false;
    return String(slot.endTime) <= String(slot.startTime);
  });
}

(async function run() {
  print(`Database: ${db.getName()}`);

  // Everything, either way. A course whose dates are not both text cannot be
  // read here at all, and a repair script that quietly ignores a whole shape is
  // the failure it exists to fix, so the count is stated rather than assumed.
  // mongosh's reads return promises, so every one of them is awaited. `await` on
  // a value that is already resolved is a no-op, which keeps this correct on
  // either side of that line.
  const notBothText = await db.courses.countDocuments({
    $or: [
      { startDate: { $not: { $type: "string" } } },
      { endDate: { $not: { $type: "string" } } },
    ],
  });

  const all = await db.courses
    .find(
      { startDate: { $type: "string" }, endDate: { $type: "string" } },
      { title: 1, type: 1, instructorId: 1, startDate: 1, endDate: 1, days: 1 },
    )
    .toArray();

  print(
    `${all.length} course(s) carry both dates as text; ${notBothText} do not and are not read here.\n`,
  );
  print(
    APPLY
      ? "APPLYING — end dates below are being written.\n"
      : "DRY RUN — nothing will be written. Set APPLY = true to write.\n",
  );

  const inverted = [];
  const unreadable = [];
  const repaired = [];

  for (const course of all) {
    const start = readDate(course.startDate);
    const end = readDate(course.endDate);
    if (!start || !end) {
      unreadable.push(course);
      continue;
    }
    if (dayKey(end) >= dayKey(start)) continue;
    inverted.push({ course: course, start: start, end: end });
  }

  for (const row of inverted) {
    const course = row.course;
    const label =
      `"${course.title}" (${course.type || "no type"}) _id=${course._id}\n` +
      `           start ${course.startDate}\n` +
      `           end   ${course.endDate}`;

    if (gapMonths(row.start, row.end) < YEAR_SCALE_GAP_MONTHS) {
      print(
        `  SKIP     ${label}\n           — less than ${YEAR_SCALE_GAP_MONTHS} month(s) before the start, too small to read as a lost year.`,
      );
      continue;
    }

    const next = oneYearLater(row.end);
    if (dayKey(next) < dayKey(row.start)) {
      print(`  SKIP     ${label}\n           — a year later is still before the start.`);
      continue;
    }

    repaired.push(course);

    if (!APPLY) {
      print(`  WOULD BE ${label}\n           end   → ${asDate(render(next), 'dry run')}`);
      continue;
    }

    // The old value rides in the filter as well as the _id, so a row someone
    // edits between the read above and this write is left alone rather than
    // overwritten from a stale copy.
    const result = await db.courses.updateOne(
      { _id: course._id, endDate: course.endDate },
      { $set: { endDate: asDate(render(next), 'course ' + JSON.stringify(course.title)) } },
    );
    if (result.matchedCount !== 1) {
      print(
        `  CHANGED  ${label}\n           — the row moved while this script was reading it; nothing written. Run it again.`,
      );
      continue;
    }
    print(`  REPAIRED ${label}\n           end   → ${render(next)}`);
  }

  if (unreadable.length) {
    print(
      `\n${unreadable.length} course(s) store a date string this script cannot read, so whether they\nend before they start cannot be told here:`,
    );
    for (const course of unreadable) {
      print(
        `  · "${course.title}" startDate=${JSON.stringify(course.startDate)} endDate=${JSON.stringify(course.endDate)}`,
      );
    }
    print("  These need their real dates read by hand — nothing here will guess at them.");
  }

  print(
    `\n${inverted.length} inverted course(s) found; ${repaired.length} ${APPLY ? "repaired" : "would be repaired"}.`,
  );
  if (!inverted.length) print("Nothing to repair.");

  // What the repair has to satisfy, read back from the database rather than
  // reported from memory: the calendar and the reminder sweep both ask whether
  // endDate is on or after startDate, so that is the question asked here.
  if (APPLY && repaired.length) {
    print("\nRead back:");
    const ids = repaired.map((c) => c._id);
    const back = await db.courses
      .find({ _id: { $in: ids } }, { title: 1, startDate: 1, endDate: 1, days: 1 })
      .toArray();
    for (const course of back) {
      const start = readDate(course.startDate);
      const end = readDate(course.endDate);
      const ok = start && end && dayKey(end) >= dayKey(start);
      print(
        `  ${ok ? "OK  " : "FAIL"} "${course.title}" ${course.startDate} → ${course.endDate}`,
      );
      const slots = badSlots(course);
      for (const slot of slots) {
        print(
          `         check by hand: ${slot.day} is ticked ${slot.startTime}–${slot.endTime}, an end before its start`,
        );
      }
    }
    print(
      "\nNow confirm both readers, not just this one: the course appears on the provider's\n" +
        "calendar, and its next session produces a reminder. One repair, two readers.",
    );
  }
})();
