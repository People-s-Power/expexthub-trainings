/**
 * Validation for an affiliate's application (spec §3.1).
 *
 * Extracted from the controllers because two write paths accept these fields —
 * the signup form and the profile editor — and they must agree. A rule enforced
 * at signup but not at profile update (or the reverse) is not a rule.
 *
 * URL safety lives in `utils/normalizeUrl.js`, shared with the platform settings
 * store: the same `javascript:`-in-a-text-box problem applies to any field that
 * becomes a link, so it is solved once rather than per feature.
 */

const { normalizeUrl } = require('./normalizeUrl.js');

const SOCIAL_KEYS = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok', 'whatsapp'];

const AFFILIATE_TYPES = ['individual', 'organisation'];

/** Per-field length caps, matching the ones the profile endpoint already used. */
const MAX = {
  businessName: 160,
  website: 200,
  referralSource: 160,
  promotionMethod: 500,
  audienceSize: 80,
  payoutPreference: 40,
  social: 200,
};

const clean = (value, limit) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

/**
 * Builds the `affiliateProfile` fields for a new affiliate from a signup body.
 *
 * Returns `{ ok: true, value }` with only the fields that were supplied, or
 * `{ ok: false, message }` for a request that must be refused. Never throws: a
 * malformed body is a 400, not a 500.
 *
 * The marketing questions (how they heard about the programme, how they intend to
 * promote it, audience size) are collected but deliberately not required. They
 * inform a reviewer rather than gate an account, and the affiliate can fill them
 * in later from their profile — refusing a signup over an unanswered
 * "how did you hear about us?" would lose the applicant entirely.
 */
function parseAffiliateApplication(rawBody) {
  // `rawBody = {}` would not have covered this: a default parameter only applies
  // to `undefined`, so an explicit `null` body — which a malformed request can
  // produce — sailed past it and threw on the first property read, turning a
  // client error into a 500.
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};

  // The profile may arrive nested under `affiliateProfile` or flat on the body;
  // both are read so a caller cannot silently have its fields ignored by picking
  // the wrong shape.
  const source =
    body.affiliateProfile && typeof body.affiliateProfile === 'object'
      ? body.affiliateProfile
      : body;

  const rawType = clean(source.type, 20) || clean(source.affiliateType, 20);
  const type = rawType ? rawType.toLowerCase() : 'individual';
  if (!AFFILIATE_TYPES.includes(type)) {
    return { ok: false, message: 'Affiliate type must be individual or organisation' };
  }

  const businessName = clean(source.businessName, MAX.businessName);
  if (type === 'organisation' && !businessName) {
    return { ok: false, message: 'Please provide your organisation name' };
  }

  const value = { type };
  if (businessName) value.businessName = businessName;

  const website = normalizeUrl(source.website);
  if (website) value.website = website;

  const referralSource = clean(source.referralSource, MAX.referralSource);
  if (referralSource) value.referralSource = referralSource;

  const promotionMethod = clean(source.promotionMethod, MAX.promotionMethod);
  if (promotionMethod) value.promotionMethod = promotionMethod;

  const audienceSize = clean(source.audienceSize, MAX.audienceSize);
  if (audienceSize) value.audienceSize = audienceSize;

  const payoutPreference = clean(source.payoutPreference, MAX.payoutPreference);
  if (payoutPreference) value.payoutPreference = payoutPreference;

  const socialSource = source.socialLinks;
  if (socialSource && typeof socialSource === 'object') {
    const socialLinks = {};
    SOCIAL_KEYS.forEach((key) => {
      const normalized = normalizeUrl(socialSource[key]);
      // A link that will not parse is dropped rather than echoed back, so the
      // stored document can never hold a value the renderer has to distrust.
      if (normalized) socialLinks[key] = normalized.slice(0, MAX.social);
    });
    if (Object.keys(socialLinks).length) value.socialLinks = socialLinks;
  }

  return { ok: true, value };
}

module.exports = { parseAffiliateApplication, SOCIAL_KEYS, AFFILIATE_TYPES, MAX };
