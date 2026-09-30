const crypto = require('crypto');
const Counter = require('../models/counter');
const User = require('../models/user');

// Crockford-style alphabet: no I, L, O or U, so a code read aloud or copied off a
// screenshot cannot be mistyped as 1/0 or mistaken for a rude word.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

const AFFILIATE_ID_SEQUENCE = 'affiliateId';
const AFFILIATE_ID_PREFIX = 'EXP-P-';
const AFFILIATE_ID_PAD = 6;

/**
 * Allocates the next affiliate serial (e.g. `EXP-P-000125`).
 *
 * The increment is a single atomic `$inc` on a counter document, so two signups
 * racing in the same millisecond are serialised by the database rather than by
 * application logic. `upsert` means the very first call creates the counter at 1
 * without a separate seed step.
 *
 * If a serial is somehow already taken — a restored database, an account created
 * by hand — the loop steps past it rather than handing back a duplicate, which
 * would fail the unique index and leave the affiliate with no identifier at all.
 */
async function nextAffiliateId() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const counter = await Counter.findOneAndUpdate(
      { _id: AFFILIATE_ID_SEQUENCE },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const candidate = `${AFFILIATE_ID_PREFIX}${String(counter.seq).padStart(AFFILIATE_ID_PAD, '0')}`;
    const taken = await User.exists({ affiliateId: candidate });
    if (!taken) return candidate;
  }

  // Twenty-five consecutive collisions is not a race, it is a counter that has
  // fallen behind the data. Failing loudly beats issuing a duplicate.
  throw new Error('Could not allocate a unique affiliate id');
}

/**
 * Generates a short public referral code.
 *
 * Random rather than sequential on purpose: a sequential code would let anyone
 * enumerate the affiliate roster (and see how many affiliates exist) by walking
 * the alphabet. 32^8 is ~1.1e12 values, so guessing a live code is impractical.
 */
function generateAffiliateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // Modulo bias on a 256-value byte over a 32-char alphabet is nil, because 32
    // divides 256 exactly.
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Returns an affiliate code that is not already in use.
 *
 * The uniqueness check is advisory — only the unique index is authoritative, and
 * a concurrent insert can still land between the check and the caller's write.
 * Callers therefore treat a duplicate-key (11000) error on save as "retry with a
 * new code", which is why this returns a plain string rather than reserving one.
 */
async function generateUniqueAffiliateCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateAffiliateCode();
    const taken = await User.exists({ affiliateCode: candidate });
    if (!taken) return candidate;
  }
  throw new Error('Could not allocate a unique affiliate code');
}

/**
 * Mints an opaque token for a referral link click.
 *
 * Attribution resolves by this token, never by the short public code: the code is
 * visible in every link and shareable, so attributing on it alone would let a
 * student be credited to an affiliate who never referred them simply by guessing
 * a code. 32 bytes of entropy makes that infeasible.
 */
function generateReferralToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * When an account joined, as a date that is always present.
 *
 * Some early affiliate records were seeded without a `createdAt`, and with strict
 * schemas it is not written back on read — so `createdAt` is genuinely absent on
 * those documents rather than merely unselected. An ObjectId carries its creation
 * timestamp in its leading four bytes, which recovers the real join date instead
 * of leaving a blank beside every one of them.
 *
 * Returns a Date, or null only when neither source exists, so callers can format
 * without a second null check.
 */
function joinedAt(doc) {
  if (doc?.createdAt) return doc.createdAt;
  try {
    return doc?._id?.getTimestamp?.() || null;
  } catch {
    // A non-ObjectId id (or a plain string) has no timestamp to read. Returning
    // null lets the caller render a dash rather than throwing over a date.
    return null;
  }
}

/**
 * The account's affiliate serial, allocating one if it has none.
 *
 * Serials arrived with the affiliate portal. An account that predates them — or
 * one whose role was changed to `affiliate` afterwards, or that was created by
 * hand — therefore has a live affiliate account with no identity to show for it.
 * `scripts/migrateAffiliateStatus.js` backfills those in bulk, but a script has
 * to be remembered and run, and this was reported as "the affiliate id is still
 * not issued" precisely because that had not happened: the roster kept rendering
 * a blank beside real accounts.
 *
 * So the serial is now issued on first read as well. The account heals the
 * moment anything looks at it, whatever its history, and there is no window in
 * which a live affiliate is displayed without an identifier — which matters
 * beyond cosmetics, because `affiliateId` is what the roster searches on and
 * what an admin quotes when looking an affiliate up.
 *
 * Safe to call from a read path: it writes only while the field is empty, and
 * the write is conditional so two requests racing cannot overwrite each other.
 */
async function ensureAffiliateIdentity(doc) {
  if (!doc) return null;
  if (doc.affiliateId) return doc.affiliateId;

  const affiliateId = await nextAffiliateId();
  const result = await User.updateOne(
    {
      _id: doc._id,
      // Still empty — the same test the caller used, re-applied at write time so
      // this only ever fills a blank and never rewrites an issued serial.
      $or: [{ affiliateId: { $exists: false } }, { affiliateId: null }, { affiliateId: '' }],
    },
    { $set: { affiliateId } }
  );

  // Nothing modified means another request allocated one first. Its serial is
  // the stored one, and returning this call's freshly-minted serial would show
  // the reader a number the database does not hold — and burn a serial that
  // nothing will ever be issued.
  if (!result.modifiedCount) {
    const current = await User.findById(doc._id).select('affiliateId').lean();
    return current?.affiliateId || affiliateId;
  }

  return affiliateId;
}

module.exports = {
  nextAffiliateId,
  generateAffiliateCode,
  generateUniqueAffiliateCode,
  generateReferralToken,
  joinedAt,
  ensureAffiliateIdentity,
  AFFILIATE_ID_PREFIX,
};
