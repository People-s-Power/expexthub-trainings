const mongoose = require('mongoose');

/**
 * Platform settings — one document, edited by an administrator.
 *
 * A typed singleton rather than a generic key/value table. A KV store needs a
 * whitelist anyway to stop a typo creating a setting nobody reads, and it tells
 * you nothing about what a valid value looks like. Here the schema *is* the
 * validation, and what is configurable is discoverable from one file.
 *
 * The document is addressed by a fixed `_id`, so there is exactly one and it
 * cannot be duplicated by a racing write: `findOneAndUpdate({ _id: KEY }, ...,
 * { upsert: true })` is atomic on the primary key.
 *
 * This exists because `NEXT_PUBLIC_*` values are inlined into the frontend bundle
 * at build time. A video URL kept in an env var is a URL that needs a rebuild and
 * redeploy to change; kept here, it is a form field.
 */

/** The single settings document's id. There is only ever one. */
const SETTINGS_KEY = 'platform';

/**
 * Length caps per field, exported so the controller trims to exactly what the
 * schema will accept. Two copies of "500" drift apart the first time one is
 * edited, and the failure mode — a save rejected by Mongoose after the controller
 * said it was fine — surfaces as a 500 rather than a message the administrator
 * can act on.
 */
const FIELD_LIMITS = {
  affiliateOnboardingVideoUrl: 500,
  affiliateOnboardingTitle: 120,
  affiliateOnboardingBody: 500,
};

const cappedString = (field) => ({
  type: String,
  default: '',
  trim: true,
  maxlength: FIELD_LIMITS[field],
});

const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: SETTINGS_KEY },

    // ------------------------------------------------------------------ videos
    /**
     * The affiliate onboarding video, as an embeddable URL.
     *
     * Normalised to http(s) by the controller before it lands here, because it is
     * rendered as an `<iframe src>` on the affiliate dashboard and a `javascript:`
     * URL is a perfectly valid thing to type into a box labelled "video URL".
     */
    affiliateOnboardingVideoUrl: cappedString('affiliateOnboardingVideoUrl'),

    /** Copy above the video, so the wording can change without a deploy too. */
    affiliateOnboardingTitle: cappedString('affiliateOnboardingTitle'),
    affiliateOnboardingBody: cappedString('affiliateOnboardingBody'),

    // ------------------------------------------------------------------- audit
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/**
 * Fields that may be served to an unauthenticated caller.
 *
 * The public endpoint returns an explicit allowlist rather than the document,
 * because this store will accumulate settings that are not for public eyes (a
 * gateway key, an internal address). Spreading the document would leak every
 * field added from here on; naming the public ones means a new field is private
 * until someone deliberately publishes it.
 */
const PUBLIC_FIELDS = ['affiliateOnboardingVideoUrl', 'affiliateOnboardingTitle', 'affiliateOnboardingBody'];

const Settings = mongoose.model('Settings', settingsSchema);

/**
 * The settings document, created on first read if it does not exist yet.
 *
 * Upserted rather than assumed to exist: reading a setting must not be the thing
 * that 404s, and a fresh database has no settings row. `$setOnInsert` keeps the
 * write a no-op on every read after the first, so schema defaults still apply.
 */
async function getSettings() {
  return Settings.findOneAndUpdate(
    { _id: SETTINGS_KEY },
    { $setOnInsert: { _id: SETTINGS_KEY } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/** Just the publicly-servable subset, with blanks rather than missing keys. */
async function getPublicSettings() {
  const doc = await getSettings();
  return PUBLIC_FIELDS.reduce((acc, field) => {
    acc[field] = doc[field] || '';
    return acc;
  }, {});
}

module.exports = Settings;
module.exports.SETTINGS_KEY = SETTINGS_KEY;
module.exports.PUBLIC_FIELDS = PUBLIC_FIELDS;
module.exports.FIELD_LIMITS = FIELD_LIMITS;
module.exports.getSettings = getSettings;
module.exports.getPublicSettings = getPublicSettings;
