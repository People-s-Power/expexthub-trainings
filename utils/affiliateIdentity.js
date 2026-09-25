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

module.exports = {
  nextAffiliateId,
  generateAffiliateCode,
  generateUniqueAffiliateCode,
  generateReferralToken,
  AFFILIATE_ID_PREFIX,
};
