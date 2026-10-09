/**
 * One-off migration: give the tutor revenue share a type and a cap.
 *
 * A provider's tutoring rate used to be a single number called `percentage`. It is
 * now a `{ type, value }` pair — a percentage of what the student pays, or a flat
 * fee for the course — plus an optional per-student cap. Three repairs follow:
 *
 *   1. `tutorRevenueShare.percentage` -> `tutorRevenueShare.value`. The field holds
 *      naira when the type is `fixed`, and a field named `percentage` holding naira
 *      is the label-versus-code lie this change exists to remove.
 *   2. `type: 'percentage'` on anything that carries a value but no type — every
 *      existing rate was a percentage, because that is all there was. Setting the
 *      value without the type would leave the split reading a naira fee as a
 *      proportion.
 *   3. `maxShareCap: 0` where it is missing. 0 is the documented "no cap", so this
 *      is the pre-existing behaviour written down rather than a policy invented
 *      here.
 *
 * Idempotent and re-runnable: every statement is filtered on the condition it
 * fixes, so a second run matches nothing and reports zero. `--dry-run` reports what
 * would change without writing anything.
 *
 * **Run this before deploying the code that reads `value`.** There is deliberately
 * no read-through shim (`settings.value ?? settings.percentage`) — a shim would
 * make a skipped migration invisible, which is exactly the failure it would exist to
 * prevent. Until this has run, an account that set a rate under the old field name
 * resolves to 0 and pays its tutors nothing.
 *
 * The tutor programme has never been live, so this is expected to be a no-op; it
 * exists because the backend cannot be run from this machine to confirm that, and
 * `migrateAffiliateStatus.js` / `migratePartnerToAffiliate.js` are the precedent.
 *
 *   node scripts/migrateTutorShareValue.js --dry-run
 *   node scripts/migrateTutorShareValue.js
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
  console.log(DRY_RUN ? 'Connected. DRY RUN — nothing will be written.\n' : 'Connected.\n');

  // The raw driver, not the model: a `default` or a validator quietly participating
  // in a data repair is how a migration writes something nobody asked for.
  const users = mongoose.connection.collection('users');

  const RATE = 'tutorRevenueShare';

  // --- 1. `percentage` -> `value` ---------------------------------------------
  const hasLegacy = { [`${RATE}.percentage`]: { $exists: true } };
  const legacyCount = await users.countDocuments(hasLegacy);
  console.log(`${legacyCount} account(s) still carry ${RATE}.percentage.`);

  if (legacyCount) {
    // Only where the new name is free. `$rename` errors when its target exists, and
    // a document carrying both is a state this script cannot guess its way out of —
    // it is reported below instead of being overwritten.
    const renamable = { ...hasLegacy, [`${RATE}.value`]: { $exists: false } };
    if (DRY_RUN) {
      console.log(`  would rename ${await users.countDocuments(renamable)} of them to ${RATE}.value.`);
    } else {
      const renamed = await users.updateMany(
        renamable,
        { $rename: { [`${RATE}.percentage`]: `${RATE}.value` } },
      );
      console.log(`  renamed ${renamed.modifiedCount} to ${RATE}.value.`);
    }
  }

  // --- 2. Every rate gets a type ----------------------------------------------
  // A rate with no type is ambiguous, and the split resolves an unknown type to
  // `percentage` — so leaving it unset would work by accident rather than by
  // record. Written down instead, since every rate that predates this was one.
  const needsType = { [`${RATE}.value`]: { $exists: true }, [`${RATE}.type`]: { $exists: false } };
  const typeCount = await users.countDocuments(needsType);
  console.log(`\n${typeCount} account(s) have a rate but no ${RATE}.type.`);
  if (typeCount) {
    if (DRY_RUN) {
      console.log("  would set type to 'percentage' on all of them.");
    } else {
      const typed = await users.updateMany(needsType, { $set: { [`${RATE}.type`]: 'percentage' } });
      console.log(`  set type to 'percentage' on ${typed.modifiedCount}.`);
    }
  }

  // --- 3. Every rate gets a cap -----------------------------------------------
  const needsCap = { [`${RATE}.value`]: { $exists: true }, [`${RATE}.maxShareCap`]: { $exists: false } };
  const capCount = await users.countDocuments(needsCap);
  console.log(`\n${capCount} account(s) have a rate but no ${RATE}.maxShareCap.`);
  if (capCount) {
    if (DRY_RUN) {
      console.log('  would set maxShareCap to 0 (no cap) on all of them.');
    } else {
      const capped = await users.updateMany(needsCap, { $set: { [`${RATE}.maxShareCap`]: 0 } });
      console.log(`  set maxShareCap to 0 on ${capped.modifiedCount}.`);
    }
  }

  // --- What is there now ------------------------------------------------------
  const after = await users
    .aggregate([
      { $match: { [`${RATE}.value`]: { $exists: true } } },
      { $group: { _id: { type: { $ifNull: [`$${RATE}.type`, '(none)'] }, enabled: `$${RATE}.enabled` }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();

  const total = after.reduce((n, row) => n + row.count, 0);
  console.log(`\nAccounts with a tutoring rate, ${DRY_RUN ? '(would be) ' : ''}after (${total} total):`);
  after.forEach((row) => {
    const type = String(row._id.type || '(none)').padEnd(12);
    const state = row._id.enabled === true ? 'on' : 'off';
    console.log(`  ${type} ${state.padEnd(4)} ${row.count}`);
  });

  // Neither of these should ever be non-zero. They are the two states the new code
  // cannot interpret, and both are silent in production — a rate with no type still
  // pays, and a rate with no value pays nothing at all.
  const stillLegacy = await users.countDocuments(hasLegacy);
  const stillUntyped = await users.countDocuments({
    [`${RATE}.value`]: { $exists: true },
    [`${RATE}.type`]: { $exists: false },
  });
  if (stillLegacy) {
    console.log(`\nWARNING: ${stillLegacy} account(s) still carry ${RATE}.percentage — a target value already exists. Resolve by hand.`);
  }
  if (stillUntyped) {
    console.log(`\nWARNING: ${stillUntyped} account(s) still have a rate with no type.`);
  }
  if (!stillLegacy && !stillUntyped) {
    console.log('\nEvery tutoring rate is on the new shape.');
  }
  if (DRY_RUN) console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
}

main()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
