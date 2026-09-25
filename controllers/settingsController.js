const AuditLog = require('../models/auditLog');
const User = require('../models/user');
const Settings = require('../models/settings');
const { FIELD_LIMITS, PUBLIC_FIELDS } = Settings;
const { normalizeUrl } = require('../utils/normalizeUrl.js');

/**
 * Platform settings.
 *
 * Two audiences share this resource, and they see different things:
 *
 *   - Anonymous visitors and signed-in users read the **public subset**, which is
 *     an allowlist of fields. This is what lets the affiliate dashboard fetch the
 *     onboarding video at runtime instead of baking it into the bundle.
 *   - An administrator reads and writes the whole document.
 *
 * The split is why the public read never returns the document itself. A settings
 * store grows fields that are not for public eyes, and the one that leaks is
 * always the one added after the endpoint was written.
 *
 * Writes are audit-logged: a change here alters what every user sees, so who
 * changed it and what it was before belongs in the same trail as an affiliate
 * approval.
 */

/** Text fields an administrator may write, and how each is cleaned. */
const TEXT_FIELDS = ['affiliateOnboardingTitle', 'affiliateOnboardingBody'];

function logAudit({ req, action, entity, entityId, before, after, note }) {
  AuditLog.create({
    actor: req.user?.id,
    actorRole: req.user?.role,
    actorName: req.user?.fullName,
    action,
    entity,
    entityId: entityId ? String(entityId) : undefined,
    before,
    after,
    note,
    ip: req.ip,
    userAgent: req.headers?.['user-agent'],
    at: new Date(),
  }).catch((error) => console.error('Audit log write failed:', action, error.message));
}

/** The allowlisted subset, for any caller. */
exports.getPublicSettings = async (req, res) => {
  try {
    const settings = await Settings.getPublicSettings();

    // Cacheable, but only briefly. These values change rarely, so a short shared
    // cache keeps the endpoint from being a database read on every dashboard
    // mount — while still letting an administrator's edit appear within a minute
    // without anyone having to purge anything.
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ settings });
  } catch (error) {
    console.error('Public settings read failed:', error);
    return res.status(500).json({ message: 'Could not load platform settings' });
  }
};

/** The full document, for the admin console. */
exports.getSettings = async (req, res) => {
  try {
    const doc = await Settings.getSettings();
    const settings = doc.toObject();

    // Resolved to a name: `updatedBy` is an ObjectId, and an ObjectId rendered in
    // a console is a string of hex that tells the reader nothing. The audit log
    // holds the same fact, but "who last changed this" is asked far more often
    // than the log is opened.
    let updatedByName = null;
    if (settings.updatedBy) {
      const actor = await User.findById(settings.updatedBy).select('fullname organizationName');
      updatedByName = actor ? actor.fullname || actor.organizationName || null : null;
    }

    return res.json({
      settings: PUBLIC_FIELDS.reduce((acc, field) => {
        acc[field] = settings[field] || '';
        return acc;
      }, {}),
      meta: {
        updatedAt: settings.updatedAt || null,
        updatedByName,
      },
    });
  } catch (error) {
    console.error('Settings read failed:', error);
    return res.status(500).json({ message: 'Could not load platform settings' });
  }
};

/**
 * Saves platform settings.
 *
 * Only the fields named in `TEXT_FIELDS` and the video URL are writable, so a
 * request cannot set `updatedBy` or invent a field the schema does not declare.
 *
 * An unusable URL is **refused**, not dropped. The affiliate signup form silently
 * discards a link that will not parse, because there the person is mid-signup and
 * a lost social link is a smaller harm than a blocked registration. Here the
 * person is an administrator editing one field with nothing else in flight, so
 * "saved" over a value that was quietly thrown away would be a lie — and they
 * would go on believing the video was set.
 */
exports.updateSettings = async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const doc = await Settings.getSettings();
    const before = PUBLIC_FIELDS.reduce((acc, field) => {
      acc[field] = doc[field] || '';
      return acc;
    }, {});

    const update = {};
    let touched = false;

    if (Object.prototype.hasOwnProperty.call(body, 'affiliateOnboardingVideoUrl')) {
      touched = true;
      const raw = body.affiliateOnboardingVideoUrl;

      if (raw === null || raw === undefined || String(raw).trim() === '') {
        // Clearing is legitimate: it is how the "no video yet" placeholder comes
        // back, and how an administrator removes a video that was taken down.
        update.affiliateOnboardingVideoUrl = '';
      } else {
        const url = normalizeUrl(String(raw), {
          // Normalised without the cap first, so the length can be *measured*
          // rather than silently trimmed. `normalizeUrl` slices to `maxLength`,
          // which is right for a decorative social link and wrong here: a
          // truncated embed URL is a video that will not play, with nothing on
          // screen to say why. This is the one field where an over-long value is
          // refused outright.
          maxLength: Number.MAX_SAFE_INTEGER,
          // An embed URL almost always lives on a registrable host; requiring one
          // is what rejects `javascript:alert(1)` shape-by-shape at the door.
          requireHost: true,
        });

        if (!url) {
          return res.status(400).json({
            message: 'Enter a valid video address starting with http:// or https://',
          });
        }
        if (url.length > FIELD_LIMITS.affiliateOnboardingVideoUrl) {
          return res.status(400).json({
            message: `That video address is too long (${url.length} characters, limit ${FIELD_LIMITS.affiliateOnboardingVideoUrl})`,
          });
        }
        update.affiliateOnboardingVideoUrl = url;
      }
    }

    for (const field of TEXT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      touched = true;

      const value = body[field];
      if (value === null || value === undefined) {
        update[field] = '';
        continue;
      }
      if (typeof value !== 'string') {
        return res.status(400).json({ message: `${field} must be text` });
      }
      update[field] = value.trim().slice(0, FIELD_LIMITS[field]);
    }

    // A PUT with nothing recognised is a caller bug worth reporting rather than a
    // no-op "saved" that leaves the console believing it wrote something.
    if (!touched) {
      return res.status(400).json({ message: 'No settings were provided' });
    }

    update.updatedBy = req.user?.id || null;
    doc.set(update);

    try {
      await doc.save();
    } catch (error) {
      // The schema caps lengths too, so a value trimmed to the cap above can still
      // fail if the two ever disagree. That is a bad request, not a server fault.
      if (error?.name === 'ValidationError') {
        return res.status(400).json({ message: 'One of the settings is too long' });
      }
      throw error;
    }

    logAudit({
      req,
      action: 'settings.updated',
      entity: 'Settings',
      entityId: doc._id,
      before,
      after: update,
    });

    const settings = PUBLIC_FIELDS.reduce((acc, field) => {
      acc[field] = doc[field] || '';
      return acc;
    }, {});

    return res.json({ message: 'Settings saved', settings });
  } catch (error) {
    console.error('Settings update failed:', error);
    return res.status(500).json({ message: 'Could not save platform settings' });
  }
};
