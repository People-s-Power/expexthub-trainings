const express = require('express');
const affiliateRouter = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const affiliate = require('../controllers/affiliateController');
const adminAffiliate = require('../controllers/adminAffiliateController');
const { TUTOR_ROLES, TUTOR_ONLY } = require('../utils/roles.js');
const { generalLimiter, walletLimiter } = require('../middlewares/rateLimiter.js');

// -----------------------------------------------------------------------------
// Public routes
//
// No `router.use(authenticate, ...)` on this router: it carries four audiences —
// anonymous signup, affiliates, training providers, and admins — so each route
// states its own guard. A blanket middleware here would either lock the public
// routes out or leave the privileged ones open.
// -----------------------------------------------------------------------------

// The affiliate picker on the student signup form. Rate-limited despite being a
// read: it is unauthenticated and searchable, so it is the natural target for
// scraping the affiliate roster.
affiliateRouter.get('/directory', generalLimiter, affiliate.directory);

// Referral-link click recording. Public by necessity — it fires before the
// visitor has an account.
//
// `generalLimiter`, not `mailLimiter`: this endpoint sends no email, and its
// callers are anonymous visitors arriving from a shared link. A referral link
// posted into a WhatsApp group puts everyone on one carrier NAT behind a single
// key, so a tight per-IP budget would start refusing real clicks — and a refused
// click is lost attribution the affiliate can never recover.
affiliateRouter.post('/attribute', generalLimiter, affiliate.attribute);

// -----------------------------------------------------------------------------
// Provider routes — the commission settings the training provider controls
// (requirement 2). Reached with the tutor family's session, not an affiliate's.
// -----------------------------------------------------------------------------

affiliateRouter.get('/settings', authenticate, authorize(...TUTOR_ROLES), affiliate.getSettings);
affiliateRouter.put('/settings', authenticate, authorize(...TUTOR_ONLY), affiliate.updateSettings);

// What affiliates have earned on this provider's own courses.
affiliateRouter.get(
  '/course-commissions',
  authenticate,
  authorize(...TUTOR_ROLES),
  generalLimiter,
  affiliate.listCourseCommissions
);
affiliateRouter.get('/courses', authenticate, authorize(...TUTOR_ONLY), adminAffiliate.listProviderCourses);
affiliateRouter.put(
  '/courses/:courseId/commission',
  authenticate,
  authorize(...TUTOR_ONLY),
  adminAffiliate.updateCourseCommission
);

// -----------------------------------------------------------------------------
// Admin routes. Mounted under /admin/… so the affiliate surface stays one router,
// but each carries its own admin guard — and these are declared *before* the
// affiliate-wide middleware below, which would otherwise reject an admin.
// -----------------------------------------------------------------------------

affiliateRouter.get('/admin/stats', authenticate, authorize('admin'), adminAffiliate.stats);
affiliateRouter.get('/admin/affiliates', authenticate, authorize('admin'), adminAffiliate.listAffiliates);
affiliateRouter.get('/admin/affiliates/:id', authenticate, authorize('admin'), adminAffiliate.getAffiliate);
affiliateRouter.patch(
  '/admin/affiliates/:id/status',
  authenticate,
  authorize('admin'),
  adminAffiliate.updateAffiliateStatus
);
affiliateRouter.get('/admin/commissions', authenticate, authorize('admin'), adminAffiliate.listCommissions);
affiliateRouter.patch(
  '/admin/commissions/:ref/reverse',
  authenticate,
  authorize('admin'),
  adminAffiliate.reverseCommission
);
affiliateRouter.post(
  '/admin/commissions/:ref/reverse',
  authenticate,
  authorize('admin'),
  adminAffiliate.reverseCommission
);
affiliateRouter.get('/admin/withdrawals', authenticate, authorize('admin'), adminAffiliate.listWithdrawals);
affiliateRouter.get('/admin/audit', authenticate, authorize('admin'), adminAffiliate.listAudit);

// -----------------------------------------------------------------------------
// Affiliate routes. Guarded wholesale from here down — every handler below also
// scopes its queries by the caller's own id, so this guard decides *who may
// call* and the controllers decide *what they may see*.
// -----------------------------------------------------------------------------

affiliateRouter.use(authenticate, authorize('affiliate'));

affiliateRouter.get('/summary', generalLimiter, affiliate.summary);
affiliateRouter.get('/performance', generalLimiter, affiliate.performance);

affiliateRouter.get('/students', generalLimiter, affiliate.listStudents);
affiliateRouter.post('/students', generalLimiter, affiliate.createStudent);
affiliateRouter.get('/students/:id', generalLimiter, affiliate.getStudent);
affiliateRouter.put('/students/:id', generalLimiter, affiliate.updateStudent);

affiliateRouter.get('/referral', generalLimiter, affiliate.referral);

affiliateRouter.get('/wallet', generalLimiter, affiliate.wallet);
affiliateRouter.get('/transactions', generalLimiter, affiliate.listTransactions);
affiliateRouter.get('/commissions', generalLimiter, affiliate.listCommissions);
affiliateRouter.post('/withdraw', walletLimiter, affiliate.withdraw);

affiliateRouter.get('/appointments', generalLimiter, affiliate.listAppointments);
affiliateRouter.post('/appointments', generalLimiter, affiliate.createAppointment);
affiliateRouter.put('/appointments/:id', generalLimiter, affiliate.updateAppointment);
affiliateRouter.delete('/appointments/:id', generalLimiter, affiliate.deleteAppointment);

affiliateRouter.get('/profile', generalLimiter, affiliate.getProfile);
affiliateRouter.put('/profile', generalLimiter, affiliate.updateProfile);
affiliateRouter.put('/bank-details', walletLimiter, affiliate.updateBankDetails);

affiliateRouter.get('/notifications', generalLimiter, affiliate.listNotifications);
affiliateRouter.put('/notifications/read', generalLimiter, affiliate.markNotificationsRead);

module.exports = affiliateRouter;
