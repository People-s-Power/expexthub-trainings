const express = require('express');
const tutorEarningRouter = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const tutorSurface = require('../middlewares/tutorSurface');
const tutorEarning = require('../controllers/tutorEarningController');
const { TUTOR_ROLES } = require('../utils/roles.js');
const { generalLimiter } = require('../middlewares/rateLimiter.js');

/**
 * The tutor earning ledger.
 *
 * Its own router rather than a corner of `/affiliate`, because the two programmes
 * are separate: an affiliate's commission is funded by the platform out of its
 * fee, a tutor's share is carved out of the provider's own net, and an account can
 * be both. Filing one under the other's settings tree is how the wrong rate ends
 * up applied to the wrong person.
 *
 * Each route states its own guard, as `/affiliate` does: this router carries two
 * audiences — a provider (and their delegated team) and an admin — and a blanket
 * middleware would lock one of them out.
 */

// -----------------------------------------------------------------------------
// Provider routes. Reading money, so both are the same "View Payments" grant that
// opens the payment records; a team member holding it reaches the account they are
// acting for, which is exactly what `scopeIdOf(req)` resolves in the controller.
// -----------------------------------------------------------------------------

tutorEarningRouter.get(
  '/instructors',
  authenticate,
  tutorSurface(TUTOR_ROLES, 'View Payments'),
  generalLimiter,
  tutorEarning.listInstructors
);

tutorEarningRouter.get(
  '/summary',
  authenticate,
  tutorSurface(TUTOR_ROLES, 'View Payments'),
  generalLimiter,
  tutorEarning.summary
);

// -----------------------------------------------------------------------------
// Admin routes. The same table unscoped — the platform-wide My Instructors screen.
// Declared under its own prefix with its own admin guard, matching how the
// affiliate surface nests its admin routes rather than inventing a second router.
// -----------------------------------------------------------------------------

tutorEarningRouter.get(
  '/admin/instructors',
  authenticate,
  authorize('admin'),
  generalLimiter,
  tutorEarning.listInstructors
);

tutorEarningRouter.get(
  '/admin/summary',
  authenticate,
  authorize('admin'),
  generalLimiter,
  tutorEarning.summary
);

module.exports = tutorEarningRouter;
