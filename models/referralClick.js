const mongoose = require('mongoose');

/**
 * A recorded visit to an affiliate's referral link.
 *
 * Referral attribution cannot rely on a browser cookie alone: the student may
 * clear it, open the link in a different browser, or land on the site and only
 * sign up days later. Recording the click server-side — keyed by an opaque token
 * that is also placed in the URL — means attribution survives all three, because
 * the signup request can present the token and the server resolves it here.
 *
 * Rows are never deleted, so a conversion stays attributable after the fact.
 */
const referralClickSchema = new mongoose.Schema(
  {
    // The affiliate's short public code, as it appeared in the link.
    code: { type: String, required: true, index: true },
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Opaque, unguessable token minted per click and carried in the URL. The code
    // alone is public and enumerable, so attribution is resolved by token — a
    // student cannot be attributed to an affiliate by guessing a short code.
    token: { type: String, required: true, unique: true, index: true },

    ip: String,
    userAgent: String,
    referrer: String,
    landingPath: String,

    // Set when a signup presents this token and the click is credited.
    convertedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    convertedAt: { type: Date },

    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

const ReferralClick = mongoose.model('ReferralClick', referralClickSchema);

module.exports = ReferralClick;
