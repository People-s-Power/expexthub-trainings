/**
 * One-off migration: fold the affiliate approval ladder into active/deactivated.
 *
 * Affiliates used to be approved by hand, in five states: `pending`,
 * `under_review`, `approved`, `rejected`, `suspended`. Approval has been removed —
 * every signup is live immediately — so the only two states left are whether an
 * account may currently refer and earn.
 *
 * The mapping is by what a state *meant*, not how it was spelled:
 *   pending, under_review, approved  -> active      (all meant "not switched off";
 *                                                    the first two only existed to
 *                                                    wait for an approval that no
 *                                                    longer happens)
 *   rejected, suspended              -> deactivated (both meant "switched off")
 *
 * It also repairs two gaps that predate this change and are visible in the admin
 * console as a dash:
 *
 *   1. `affiliateId` (the `EXP-P-000125` serial) was designed, and the allocator
 *      was written, but nothing ever called it — so no affiliate has one. They are
 *      allocated here, oldest account first, so the numbering follows signup order.
 *   2. Some accounts have no `createdAt`, which renders as "—" in the roster. Every
 *      ObjectId carries its own creation time in its leading four bytes, so the
 *      real date is recoverable rather than guessable.
 *
 * `affiliateCode` is filled in for accounts that lack one. Under the old model a
 * code was only issued on approval, so an account that was never approved has
 * none — and one that is now active without a code can be active and still unable
 * to refer, which is the worst of both. Codes are never regenerated for accounts
 * that already have one: an affiliate's published links must keep working.
 *
 * Idempotent and re-runnable: every statement is filtered on the condition it
 * fixes, so a second run matches nothing and reports zero. `--dry-run` reports
 * what would change without writing anything.
 *
 * Deployment order does not matter. The application reads the legacy words as
 * their modern equivalents (see `utils/affiliateStatus.js`), so running this
 * before or after the code deploy is equally safe — nothing stops earning in the
 * window between them.
 *
 *   node scripts/migrateAffiliateStatus.js --dry-run
 *   node scripts/migrateAffiliateStatus.js
 */

require('dotenv/config');
const mongoose = require('mongoose');
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');

// Mirrors utils/affiliateIdentity.js. Duplicated rather than imported because this
// script writes through the raw driver — the model's `default: 'active'` and its
// validators must not quietly participate in a data repair.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const AFFILIATE_ID_PREFIX = 'EXP-P-';
const AFFILIATE_ID_PAD = 6;
const AFFILIATE_ID_SEQUENCE = 'affiliateId';

const TO_ACTIVE = ['pending', 'under_review', 'approved'];
const TO_DEACTIVATED = ['rejected', 'suspended'];

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

/** Every code already in use, so a new one can be checked without a round trip each. */
async function loadUsedCodes(users) {
  const rows = await users.find({ affiliateCode: { $type: 'string' } }, { projection: { affiliateCode: 1 } }).toArray();
  return new Set(rows.map((row) => row.affiliateCode));
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

  const users = mongoose.connection.collection('users');
  const counters = mongoose.connection.collection('counters');

  // --- What is there now ------------------------------------------------------
  const before = await users
    .aggregate([
      { $match: { role: 'affiliate' } },
      { $group: { _id: '$affiliateProfile.status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  console.log(`Affiliate accounts by status, before (${before.reduce((n, r) => n + r.count, 0)} total):`);
  before.forEach((row) => console.log(`  ${String(row._id || '(none)').padEnd(14)} ${row.count}`));

  // --- 1. Fold the ladder -----------------------------------------------------
  let activated = 0;
  let deactivated = 0;
  for (const [from, to] of [
    [TO_ACTIVE, 'active'],
    [TO_DEACTIVATED, 'deactivated'],
  ]) {
    if (DRY_RUN) {
      const n = await users.countDocuments({ role: 'affiliate', 'affiliateProfile.status': { $in: from } });
      if (to === 'active') activated = n;
      else deactivated = n;
      console.log(`  would set ${String(from.join(', ')).padEnd(28)} -> ${to}: ${n}`);
      continue;
    }

    // The reason fields are carried across rather than dropped: "why is this
    // account switched off" has to survive the rename, or the first support
    // question about a deactivated affiliate has no answer in the data.
    const result = await users.updateMany(
      { role: 'affiliate', 'affiliateProfile.status': { $in: from } },
      [
        {
          $set: {
            'affiliateProfile.status': to,
            ...(to === 'deactivated'
              ? {
                  'affiliateProfile.deactivationReason': {
                    $ifNull: [
                      '$affiliateProfile.deactivationReason',
                      { $ifNull: ['$affiliateProfile.suspensionReason', '$affiliateProfile.rejectionReason'] },
                    ],
                  },
                  'affiliateProfile.deactivatedAt': {
                    $ifNull: ['$affiliateProfile.deactivatedAt', '$affiliateProfile.suspendedAt'],
                  },
                }
              : {}),
          },
        },
      ],
    );
    if (to === 'active') activated = result.modifiedCount;
    else deactivated = result.modifiedCount;
    console.log(`  set ${String(from.join(', ')).padEnd(28)} -> ${to}: ${result.modifiedCount}`);
  }
  console.log(`\nFolded the status ladder: ${activated} activated, ${deactivated} deactivated.\n`);

  // --- 2. Repair missing createdAt -------------------------------------------
  // Sorted by _id so the repair runs in creation order, which keeps the log
  // readable and makes an interrupted run resumable in a predictable place.
  const missingDate = await users
    .find({ role: 'affiliate', $or: [{ createdAt: { $exists: false } }, { createdAt: null }] })
    .sort({ _id: 1 })
    .toArray();

  console.log(`${missingDate.length} affiliate account(s) have no createdAt.`);
  let datesFixed = 0;
  for (const row of missingDate) {
    // An ObjectId's leading four bytes are a Unix timestamp — the insert time of
    // the document that is missing it. Recovering the real date beats leaving a
    // dash on screen or inventing "now".
    const recovered = row._id.getTimestamp();
    console.log(`  ${row._id}  ${row.email || row.fullname || '(no email)'}  -> ${recovered.toISOString()}`);
    if (DRY_RUN) continue;
    await users.updateOne({ _id: row._id }, { $set: { createdAt: recovered, updatedAt: recovered } });
    // `submittedAt` dates the same event — when the affiliate joined — and is
    // what the profile screen shows, so it is repaired to match rather than left
    // disagreeing with the roster.
    await users.updateOne(
      { _id: row._id, 'affiliateProfile.submittedAt': { $in: [null] } },
      { $set: { 'affiliateProfile.submittedAt': recovered } },
    );
    datesFixed += 1;
  }
  if (missingDate.length) console.log(`Repaired ${DRY_RUN ? '(would repair) ' : ''}${datesFixed || missingDate.length} creation date(s).\n`);

  // --- 3. Issue missing affiliate serials ------------------------------------
  const missingSerial = await users
    .find({ role: 'affiliate', $or: [{ affiliateId: { $exists: false } }, { affiliateId: null }, { affiliateId: '' }] })
    .sort({ _id: 1 })
    .toArray();

  console.log(`${missingSerial.length} affiliate account(s) have no affiliateId.`);
  if (missingSerial.length) {
    // Continue from the highest serial already issued rather than from 1, so a
    // re-run after a partial migration cannot reissue a number that is taken.
    const highest = await users
      .find({ affiliateId: { $type: 'string' } }, { projection: { affiliateId: 1 } })
      .toArray()
      .then((rows) =>
        rows.reduce((max, row) => {
          const n = parseInt(String(row.affiliateId).replace(AFFILIATE_ID_PREFIX, ''), 10);
          return Number.isFinite(n) && n > max ? n : max;
        }, 0),
      );

    let seq = highest;
    const counter = await counters.findOne({ _id: AFFILIATE_ID_SEQUENCE });
    if (counter && Number(counter.seq) > seq) seq = Number(counter.seq);
    console.log(`  starting from ${AFFILIATE_ID_PREFIX}${String(seq + 1).padStart(AFFILIATE_ID_PAD, '0')}`);

    for (const row of missingSerial) {
      seq += 1;
      const serial = `${AFFILIATE_ID_PREFIX}${String(seq).padStart(AFFILIATE_ID_PAD, '0')}`;
      console.log(`  ${serial}  ${row.email || row.fullname || '(no email)'}`);
      if (DRY_RUN) continue;
      await users.updateOne({ _id: row._id }, { $set: { affiliateId: serial } });
    }

    if (!DRY_RUN) {
      // The counter is set past what was just handed out, so the next signup
      // continues the series instead of colliding with a backfilled serial.
      await counters.updateOne(
        { _id: AFFILIATE_ID_SEQUENCE },
        { $set: { seq }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
    }
    console.log('');
  }

  // --- 4. Issue missing referral codes ---------------------------------------
  const missingCode = await users
    .find({ role: 'affiliate', $or: [{ affiliateCode: { $exists: false } }, { affiliateCode: null }, { affiliateCode: '' }] })
    .sort({ _id: 1 })
    .toArray();

  console.log(`${missingCode.length} affiliate account(s) have no referral code.`);
  if (missingCode.length) {
    const used = await loadUsedCodes(users);
    for (const row of missingCode) {
      let code = generateCode();
      while (used.has(code)) code = generateCode();
      used.add(code);
      console.log(`  ${code}  ${row.email || row.fullname || '(no email)'}`);
      if (DRY_RUN) continue;
      await users.updateOne({ _id: row._id }, { $set: { affiliateCode: code } });
    }
    console.log('');
  }

  // --- What is there now ------------------------------------------------------
  const after = await users
    .aggregate([
      { $match: { role: 'affiliate' } },
      { $group: { _id: '$affiliateProfile.status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  console.log(`Affiliate accounts by status, ${DRY_RUN ? '(would be) ' : ''}after:`);
  after.forEach((row) => console.log(`  ${String(row._id || '(none)').padEnd(14)} ${row.count}`));

  const legacy = after.filter((row) => [...TO_ACTIVE, ...TO_DEACTIVATED].includes(row._id));
  console.log(
    legacy.length === 0
      ? '\nNo affiliate carries a legacy status any more.'
      : `\nWARNING: ${legacy.reduce((n, r) => n + r.count, 0)} still carry a legacy status.`,
  );

  const stillMissing = await users.countDocuments({
    role: 'affiliate',
    $or: [{ affiliateId: { $in: [null, ''] } }, { affiliateCode: { $in: [null, ''] } }],
  });
  console.log(
    stillMissing === 0
      ? 'Every affiliate has a serial and a referral code.'
      : `WARNING: ${stillMissing} affiliate(s) are still missing an identifier.`,
  );
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
