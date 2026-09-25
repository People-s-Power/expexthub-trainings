/**
 * One-off migration: rename the `partner` persona to `affiliate`.
 *
 * The affiliate programme was seeded under the name "partner". Everything that
 * referred to the *persona* — the role value on accounts, `registeredBy`
 * attributions, and any already-issued identifiers — is moved to "affiliate".
 *
 * What this deliberately does NOT touch:
 *   - the marketing use of the word "partner" (the "Strategic Partnerships"
 *     section, `/#partner` anchors, privacy/terms prose). That is copy about
 *     business partnerships, not about this role, and it lives in the frontend
 *     repository rather than in these collections.
 *   - any other role. `student`, `tutor`, `provider`, `team_member` and `admin`
 *     accounts are counted and left exactly as they are.
 *
 * Idempotent and re-runnable: both statements are filtered on the *old* value, so
 * a second run finds nothing and reports zero. `--dry-run` reports what would
 * change without writing.
 *
 * Run after deploying the model change, before the renamed UI ships:
 *   node scripts/migratePartnerToAffiliate.js --dry-run
 *   node scripts/migratePartnerToAffiliate.js
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

  const users = mongoose.connection.collection('users');

  // --- What is there now -----------------------------------------------------
  const roleCounts = await users
    .aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
    .toArray();

  console.log('\nAccounts by role, before:');
  roleCounts.forEach((row) => console.log(`  ${String(row._id || '(none)').padEnd(14)} ${row.count}`));

  const partnerAccounts = await users.countDocuments({ role: 'partner' });
  const anyAttributions = await users.countDocuments({ registeredBy: { $exists: true } });
  const anyReferrals = await users.countDocuments({ referredByAffiliate: { $exists: true } });

  console.log(`\n  role: "partner"                    ${partnerAccounts}`);
  console.log(`  accounts with any registeredBy     ${anyAttributions}  (only those pointing at a partner are rewritten)`);
  console.log(`  accounts with referredByAffiliate  ${anyReferrals}  (backfilled from registeredBy where an affiliate enrolled them)`);

  if (DRY_RUN) {
    // Resolve the actual ids that would be rewritten, so the report is a real
    // number rather than a guess.
    const partnerIds = await users.find({ role: 'partner' }, { projection: { _id: 1 } }).toArray();
    const ids = partnerIds.map((row) => row._id);

    const wouldRewrite = ids.length
      ? await users.countDocuments({ registeredBy: { $in: ids } })
      : 0;

    console.log(`\nDry run — nothing written.`);
    console.log(`  ${partnerAccounts} account(s) would become role: "affiliate"`);
    console.log(`  ${wouldRewrite} account(s) have registeredBy pointing at one of them`);
    return;
  }

  if (partnerAccounts === 0) {
    console.log('\nNothing to migrate — no accounts carry role: "partner".');
    return;
  }

  // --- Rewrite the role ------------------------------------------------------
  const roleResult = await users.updateMany({ role: 'partner' }, { $set: { role: 'affiliate' } });
  console.log(`\nRewrote role on ${roleResult.modifiedCount} account(s).`);

  // --- Rewrite attributions --------------------------------------------------
  // `registeredBy` is an ObjectId reference to the account that enrolled this
  // person. It is a pointer rather than a role string, so it does not *need*
  // rewriting to keep working — but leaving stale ids that no longer resolve
  // under the new role would break the affiliate student list, which filters on
  // this field.
  //
  // Every student an affiliate enrolled was, by definition, referred by them —
  // referring students is the only reason an affiliate creates an account at all
  // — so `referredByAffiliate` is backfilled from `registeredBy` for exactly those
  // rows. Students enrolled by a *provider* are untouched: the filter below is
  // restricted to ids that are affiliates, which is what keeps a provider's own
  // enrolments from being misattributed as affiliate referrals.
  //
  // This affects future payments only. Commission is generated when a payment
  // settles, never retroactively, so no back-dated earnings appear from this run.
  const affiliateIds = await users.find({ role: 'affiliate' }, { projection: { _id: 1 } }).toArray();
  const ids = affiliateIds.map((row) => row._id);

  let attributionResult = { modifiedCount: 0 };
  if (ids.length) {
    attributionResult = await users.updateMany(
      { registeredBy: { $in: ids }, referredByAffiliate: { $exists: false } },
      [{ $set: { referredByAffiliate: '$registeredBy' } }],
    );
  }
  console.log(
    `Attributed ${attributionResult.modifiedCount} enrolled student(s) to their affiliate via referredByAffiliate.`,
  );

  // --- Also bring the affiliate serials across -------------------------------
  // Accounts that already have an affiliateId or code keep them; this only fills
  // in what is missing, so nobody is left without the identifier their records
  // may already quote.
  const missingIdentity = await users.countDocuments({
    role: 'affiliate',
    $or: [{ affiliateId: { $exists: false } }, { affiliateId: null }],
  });
  if (missingIdentity) {
    console.log(
      `\nNote: ${missingIdentity} affiliate account(s) have no affiliateId yet. ` +
        `Approving them from the admin console issues one; existing accounts are not renumbered.`,
    );
  }

  // --- What is there now -----------------------------------------------------
  const afterCounts = await users
    .aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
    .toArray();

  console.log('\nAccounts by role, after:');
  afterCounts.forEach((row) => console.log(`  ${String(row._id || '(none)').padEnd(14)} ${row.count}`));

  const remaining = await users.countDocuments({ role: 'partner' });
  console.log(remaining === 0 ? '\nNo accounts remain with role: "partner".' : `\nWARNING: ${remaining} still carry role: "partner".`);
}

main()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
