/**
 * One-off backfill: repair enrollment drift — students who sit in a course's
 * `enrolledStudents` but have no matching row in `enrollments`.
 *
 * The Payments menu and the Admissions tabs read the `enrollments` array (via
 * paymentRecordController's pipeline), not `enrolledStudents`. An older code path
 * could add a student to `enrolledStudents` without ever writing an `enrollments`
 * row, so a genuinely-enrolled student went invisible there. grantCourseAccess is
 * now keyed on the enrollments row so it self-heals going forward; this clears the
 * students who drifted before that fix.
 *
 * Reads and writes the collection directly (like backfillPartPaymentConsent) so
 * string-stored ids are compared and matched by value, not silently recast by the
 * schema — the whole point here is that the ids drifted in type. The push is
 * guarded on the enrollments row and matches both id forms, so it is safe to
 * re-run and safe to overlap another writer: a student who already has a row is
 * never given a second one.
 *
 *   node scripts/backfillEnrollmentDrift.js --dry-run   # report only, writes nothing
 *   node scripts/backfillEnrollmentDrift.js             # push the missing enrollment rows
 *
 * Run after Part 1 (read fix) and Part 4 (payment backfill), so a student's plan
 * state is already settled when their status is inferred here.
 */

require('dotenv/config');
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

// A 24-hex string is a stringified ObjectId; normalise it to an ObjectId so the
// row we push matches the schema-intended type. Anything else is pushed as-is.
function toObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  const s = String(value);
  return /^[0-9a-fA-F]{24}$/.test(s) ? new mongoose.Types.ObjectId(s) : value;
}

async function main() {
  const { DB_USERNAME, DB_PASSWORD } = process.env;
  if (!DB_USERNAME || !DB_PASSWORD) {
    throw new Error('DB_USERNAME and DB_PASSWORD must be set to run this backfill');
  }

  await mongoose.connect(
    `mongodb+srv://${DB_USERNAME}:${DB_PASSWORD}@theplaint.u7pbgty.mongodb.net/?retryWrites=true&w=majority`,
  );
  console.log(`Connected.${DRY_RUN ? ' DRY RUN — nothing will be written.' : ''}`);

  const courses = mongoose.connection.collection('courses');
  const plans = mongoose.connection.collection('coursepaymentplans');

  const cursor = courses.find(
    { enrolledStudents: { $exists: true, $ne: [] } },
    { projection: { enrolledStudents: 1, enrollments: 1, updatedAt: 1, createdAt: 1 } },
  );

  const tally = { coursesScanned: 0, coursesWithDrift: 0, rowsAdded: 0, skipped: 0, errors: 0 };

  for await (const course of cursor) {
    tally.coursesScanned += 1;

    const enrolled = Array.isArray(course.enrolledStudents) ? course.enrolledStudents : [];
    const haveRow = new Set(
      (Array.isArray(course.enrollments) ? course.enrollments : [])
        .map(e => (e && e.user != null ? String(e.user) : null))
        .filter(Boolean),
    );

    // Students in enrolledStudents with no enrollments row, deduped by id string
    // (the string/ObjectId $addToSet quirk can list one student twice).
    const missing = [...new Map(
      enrolled
        .filter(s => s != null && !haveRow.has(String(s)))
        .map(s => [String(s), s]),
    ).values()];

    if (missing.length === 0) continue;
    tally.coursesWithDrift += 1;

    for (const studentId of missing) {
      const idForms = [studentId, String(studentId), toObjectId(studentId)];
      try {
        // A non-cancelled plan that still owes → the student is mid-plan; otherwise
        // (fully paid, no plan, or cancelled) treat access as full/active.
        const plan = await plans.findOne({
          courseId: { $in: [course._id, String(course._id)] },
          userId: { $in: idForms },
          status: { $ne: 'cancelled' },
        });
        const hasBalance = plan && Number(plan.amountPaidMinor || 0) < Number(plan.totalAmountMinor || 0);
        const status = hasBalance ? 'payment_plan_active' : 'active';
        // Best-effort timestamp: when the plan started if we have one, else the
        // course's own last-modified time as the plan specified.
        const enrolledOn = (plan && (plan.firstPaymentAt || plan.createdAt))
          || course.updatedAt || course.createdAt || new Date();

        if (DRY_RUN) {
          console.log(`  [dry-run] course ${course._id} student ${String(studentId)} → would add enrollment (${status})`);
          tally.rowsAdded += 1;
          continue;
        }

        const result = await courses.updateOne(
          { _id: course._id, 'enrollments.user': { $nin: idForms } },
          { $push: { enrollments: { user: toObjectId(studentId), status, enrolledOn, updatedAt: new Date() } } },
        );
        if (result.modifiedCount) {
          tally.rowsAdded += 1;
          console.log(`  course ${course._id} student ${String(studentId)} → enrollment added (${status})`);
        } else {
          tally.skipped += 1; // Row appeared concurrently — nothing to do.
        }
      } catch (error) {
        tally.errors += 1;
        console.error(`  course ${course._id} student ${String(studentId)} → ERROR —`, error.message);
      }
    }
  }

  console.log(
    `\n${DRY_RUN ? 'Dry run' : 'Backfill'} complete. Scanned ${tally.coursesScanned} course(s); `
    + `${tally.coursesWithDrift} had drift; ${DRY_RUN ? 'would add' : 'added'} ${tally.rowsAdded} row(s), `
    + `skipped ${tally.skipped}, errors ${tally.errors}.`,
  );
}

main()
  .catch(error => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
