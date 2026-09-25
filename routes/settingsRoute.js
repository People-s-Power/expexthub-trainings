const express = require('express');
const settingsRouter = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const settings = require('../controllers/settingsController');
const { generalLimiter } = require('../middlewares/rateLimiter.js');

/**
 * Platform settings.
 *
 * Mounted at `/settings`, deliberately not at `/affiliate/settings` — that path
 * already means something else and must keep meaning it: it is the *training
 * provider's* commission configuration (requirement 2), read and written with the
 * provider's own session. Collapsing the two would put the platform's
 * configuration behind a provider-scoped URL and invite exactly the wrong guard.
 */

// Public: the affiliate dashboard reads the onboarding video from here, which is
// the whole point — a value fetched at runtime is a value an administrator can
// change without a rebuild.
//
// Rate-limited despite being a read and despite the shared cache. It is
// unauthenticated, and the cache only helps callers that send a matching
// `Cache-Control`; a scraper that does not is a database read per request.
settingsRouter.get('/public', generalLimiter, settings.getPublicSettings);

// The full document. Admin-only: it is the platform's configuration surface, and
// the writes below change what every user sees.
settingsRouter.get('/', authenticate, authorize('admin'), settings.getSettings);
settingsRouter.put('/', authenticate, authorize('admin'), settings.updateSettings);

module.exports = settingsRouter;
