/**
 * One-off backfill: grandfather part payment onto courses that predate the
 * instructor consent toggle.
 *
 * Before this toggle existed, part payment was a platform capability offered on
 * every paid course. `Course.partPaymentEnabled` now defaults to false so a new
 * course only offers it when the instructor opts in — but applying that default
 * to existing courses would silently withdraw an option students can already
 * see, and would strand anyone who is part-way through deciding. So every course
 * that existed before the toggle keeps the behaviour it already had.
 *
 * Only documents with the field genuinely absent are touched, which is what
 * makes this safe to re-run: a course an instructor has since switched off has
 * `partPaymentEnabled: false` stored explicitly and is left alone.
 *
 * Run once, after deploying the model change and before the UI ships:
 *   node scripts/backfillPartPaymentConsent.js
 *   node scripts/backfillPartPaymentConsent.js --dry-run
 */

require('dotenv/config');
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const { DB_USERNAME, DB_PASSWORD } = process.env;
  if (!DB_USERNAME || !DB_PASSWORD) {
    throw new Error('DB_USERNAME and DB_PASSWORD must be set to run this migration');
  }

  await mongoose.connect(
    `mongodb+srv://${DB_USERNAME}:${DB_PASSWORD}@theplaint.u7pbgty.mongodb.net/?retryWrites=true&w=majority`,
  );
  console.log('Connected.');

  // Query the collection directly rather than through the model: Mongoose applies
  // the schema default when it hydrates a document, so a model read would report
  // `false` for exactly the legacy documents this migration needs to find.
  const courses = mongoose.connection.collection('courses');
  const filter = { partPaymentEnabled: { $exists: false } };

  const pending = await courses.countDocuments(filter);
  const paidPending = await courses.countDocuments({ ...filter, fee: { $gt: 0 } });
  console.log(`${pending} course(s) predate the toggle (${paidPending} of them are paid courses).`);

  if (DRY_RUN) {
    console.log('Dry run — nothing written.');
    return;
  }
  if (pending === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  // Free courses are set too. The flag is inert while `fee` is 0 (a free course
  // has nothing to split), but writing it uniformly means the absence of the
  // field never has to be interpreted again after this runs.
  const result = await courses.updateMany(filter, { $set: { partPaymentEnabled: true } });
  console.log(`Backfilled ${result.modifiedCount} course(s) to partPaymentEnabled: true.`);
}

main()
  .catch(error => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
