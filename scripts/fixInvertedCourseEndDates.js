/**
 * One-off repair: courses whose end date falls before their own start date.
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
 * moves it to or after the start. Where a year does not resolve the inversion
 * the row is printed and left alone — nothing here can tell a wrong year from a
 * wrong month, so the case that a year cannot explain is a case for a person.
 * Read the dry run before trusting it for that reason.
 *
 * A date is rewritten in the shape it was stored in — a four-digit year swap on
 * the ISO string the API writes — so the time of day and any suffix survive
 * untouched. The swap is verified to still name a real day, because 29 February
 * has no counterpart a year later and a bare year change would write a day that
 * does not exist; such a row falls back to the parsed date and is marked as such.
 *
 * Run after deploying the guard that stops new ones (the course form's end-date
 * check, mirrored in controllers/courseController.js):
 *   node scripts/fixInvertedCourseEndDates.js --dry-run
 *   node scripts/fixInvertedCourseEndDates.js
 */

require('dotenv/config');
const mongoose = require('mongoose');
const dayjs = require('dayjs');

const DRY_RUN = process.argv.includes('--dry-run');

// How far before its start an end date has to sit for the year to be the
// suspect. Below this the inversion is the size of a slip in the day or month,
// and adding a year would turn a small mistake into a course that runs for one.
const YEAR_SCALE_GAP_MONTHS = 3;

/** The shapes the API writes, with or without a time and a zone suffix. */
const ISO_SHAPE = /^(\d{4})(-\d{2}-\d{2}(?:T[\d:.]+Z?)?)$/;

/**
 * `"2026-01-11T13:00:00.000Z"` → `"2027-01-11T13:00:00.000Z"`, keeping the
 * stored shape. Returns null when the move cannot be made honestly.
 */
function endDateOneYearLater(stored, end) {
  const nextYear = dayjs(end).add(1, 'year');
  if (!nextYear.isValid()) return null;

  const match = ISO_SHAPE.exec(String(stored));
  if (!match) return { value: nextYear.toISOString(), reshaped: true };

  const swapped = `${Number(match[1]) + 1}${match[2]}`;
  const reparsed = dayjs(swapped);
  // A shape-preserving swap is only right if it still names the same month and
  // day. When it does not (29 February), the parsed date is used instead — it
  // rolls to 1 March, which is the only honest reading of "a year later".
  if (!reparsed.isValid() || reparsed.format('MM-DD') !== dayjs(end).format('MM-DD')) {
    return { value: nextYear.toISOString(), reshaped: true };
  }
  return { value: swapped, reshaped: false };
}

async function main() {
  const { DB_USERNAME, DB_PASSWORD } = process.env;
  if (!DB_USERNAME || !DB_PASSWORD) {
    throw new Error('DB_USERNAME and DB_PASSWORD must be set to run this migration');
  }

  await mongoose.connect(
    `mongodb+srv://${DB_USERNAME}:${DB_PASSWORD}@theplaint.u7pbgty.mongodb.net/?retryWrites=true&w=majority`,
  );
  console.log(DRY_RUN ? 'Connected. DRY RUN — nothing will be written.\n' : 'Connected.\n');

  const courses = mongoose.connection.collection('courses');

  // Read and compare in JS rather than filtering in the query. Both dates are
  // stored as strings, so a query-side comparison would only be correct while
  // every row happened to use one shape; `dayjs` reads every shape the API and
  // the older course forms wrote, which is the same reader the calendar and the
  // reminder sweep use. The collection is a list of courses, not of events, so
  // reading it whole is cheap enough for a one-off.
  const all = await courses
    .find({ startDate: { $type: 'string' }, endDate: { $type: 'string' } })
    .project({ title: 1, type: 1, instructorId: 1, startDate: 1, endDate: 1 })
    .toArray();

  const inverted = [];
  for (const course of all) {
    const start = dayjs(course.startDate);
    const end = dayjs(course.endDate);
    if (!start.isValid() || !end.isValid()) continue;
    if (!end.startOf('day').isBefore(start.startOf('day'))) continue;
    inverted.push({ course, start, end });
  }

  console.log(`${all.length} course(s) carry both dates as text; ${inverted.length} end before they start.\n`);
  if (!inverted.length) {
    console.log('Nothing to repair.');
    return;
  }

  let repaired = 0;
  const unresolved = [];

  for (const { course, start, end } of inverted) {
    const label = `"${course.title}" (${course.type || 'no type'}) ${course.startDate} → ${course.endDate}`;
    const gapMonths = start.diff(end, 'month', true);

    if (gapMonths < YEAR_SCALE_GAP_MONTHS) {
      unresolved.push(course);
      console.log(`  SKIP     ${label} — only ${gapMonths.toFixed(1)} month(s) apart, too small to read as a lost year.`);
      continue;
    }

    const repair = endDateOneYearLater(course.endDate, end);
    if (!repair || dayjs(repair.value).startOf('day').isBefore(start.startOf('day'))) {
      unresolved.push(course);
      console.log(`  SKIP     ${label} — a year later is still before the start.`);
      continue;
    }

    repaired += 1;
    console.log(
      `  ${DRY_RUN ? 'WOULD BE' : 'REPAIRED'} ${label} → ${repair.value}` +
        (repair.reshaped ? '  (stored shape did not survive the move; written as ISO)' : ''),
    );
    if (!DRY_RUN) await courses.updateOne({ _id: course._id }, { $set: { endDate: repair.value } });
  }

  console.log(
    `\n${repaired} course(s) ${DRY_RUN ? 'would be repaired' : 'repaired'}; ${unresolved.length} left alone.`,
  );
  if (unresolved.length) {
    console.log('The skipped rows need their real end date from the provider: they are not a year apart.');
  }
}

// Guarded so the decision above can be exercised without a database:
//   node -e "console.log(require('./scripts/fixInvertedCourseEndDates').endDateOneYearLater('2026-01-11T13:00:00.000Z', '2026-01-11T13:00:00.000Z'))"
if (require.main === module) {
  main()
    .catch(error => {
      console.error('Repair failed:', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { endDateOneYearLater, YEAR_SCALE_GAP_MONTHS };
