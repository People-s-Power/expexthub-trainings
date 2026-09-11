const express = require('express');
const transactionRouter = express.Router();
const transactionController = require('../controllers/transactionController.js');
const authenticate = require('../middlewares/auth.js');
const authorize = require('../middlewares/authorize.js');
const { TUTOR_ROLES } = require('../utils/roles.js');
const { validateObjectId } = require('../middlewares/validateRequest.js');
const { paymentLimiter, walletLimiter, generalLimiter } = require('../middlewares/rateLimiter.js');

// Public endpoints
transactionRouter.get('/banks', generalLimiter, transactionController.getBanks);
transactionRouter.get('/verify/:txRef', transactionController.verifyCoursePayment);
transactionRouter.post('/webhook', transactionController.flutterwaveWebhook);

// Account verification (requires auth)
transactionRouter.put('/verify-account', authenticate, generalLimiter, transactionController.verifyAccount);

// Balance and transaction history (own data only)
transactionRouter.get('/balance/:userId', authenticate, validateObjectId('userId'), transactionController.getBalance);

// Wallet operations (strict limits, own account only)
transactionRouter.post('/create-recipient', authenticate, walletLimiter, transactionController.createRecipient);
transactionRouter.post('/withdraw', authenticate, walletLimiter, transactionController.withdraw);
transactionRouter.post('/pay-with', authenticate, walletLimiter, transactionController.payWith);

// Scheduled payouts. Reading the schedule needs only wallet visibility; changing
// it moves money, so the controller gates writes on "Withdraw from Wallet".
transactionRouter.get('/auto-payout', authenticate, generalLimiter, transactionController.getAutoPayout);
transactionRouter.put('/auto-payout', authenticate, walletLimiter, transactionController.updateAutoPayout);

// Wallet funding: starts a gateway checkout that credits the wallet on success.
// `/initialize-payment` is the alias the deployed frontend already calls — both
// paths resolve to the same controller so the existing contract keeps working.
transactionRouter.post('/fund-wallet', authenticate, walletLimiter, transactionController.fundWallet);
transactionRouter.post('/initialize-payment', authenticate, walletLimiter, transactionController.fundWallet);
transactionRouter.get('/verify-wallet-funding/:txRef', transactionController.verifyWalletFunding);

// Course payment endpoints (student/client only)
transactionRouter.post('/initialize-course-payment', authenticate, authorize('student', 'client'), paymentLimiter, validateObjectId('courseId'), transactionController.initializeCoursePayment);
transactionRouter.post('/pay-course-with-wallet', authenticate, authorize('student', 'client'), walletLimiter, validateObjectId('courseId'), transactionController.payCourseWithWallet);

// Part payment endpoints (student/client only). The student chooses each amount,
// so there is no per-instalment addressing any more — the plan tracks the balance.
const paymentPlanController = require('../controllers/paymentPlanController.js');
transactionRouter.post('/course-payment-plans', authenticate, authorize('student', 'client'), paymentLimiter, validateObjectId('courseId'), paymentPlanController.createPlan);
transactionRouter.get('/course-payment-plans', authenticate, authorize('student', 'client'), generalLimiter, paymentPlanController.listPlans);
transactionRouter.get('/course-payment-plans/:planId', authenticate, authorize('student', 'client'), validateObjectId('planId'), generalLimiter, paymentPlanController.getPlan);
transactionRouter.post('/course-payment-plans/:planId/payments', authenticate, authorize('student', 'client'), paymentLimiter, validateObjectId('planId'), paymentPlanController.initializePayment);
transactionRouter.post('/course-payment-plans/:planId/payments/wallet', authenticate, authorize('student', 'client'), walletLimiter, validateObjectId('planId'), paymentPlanController.payWithWallet);

// Payment records for the payments menu. Tutors and admins both reach this;
// the controller scopes rows by course ownership, so a tutor only ever sees the
// money owed on their own courses. Team members pass the role gate but the
// controller still requires the owner's "View Payments" privilege before any
// row is returned.
const paymentRecordController = require('../controllers/paymentRecordController.js');
transactionRouter.get('/payment-records', authenticate, authorize(...TUTOR_ROLES), generalLimiter, paymentRecordController.listPaymentRecords);
transactionRouter.get('/payment-records/courses', authenticate, authorize(...TUTOR_ROLES), generalLimiter, paymentRecordController.listPaymentRecordCourses);
// Admin-only: record an offline settlement of a student's outstanding balance.
transactionRouter.post('/payment-records/settle-balance', authenticate, authorize('admin'), paymentLimiter, paymentRecordController.settleStudentBalance);

// Admin-only operations
transactionRouter.post('/cancel-premium/:userId', authenticate, authorize('admin'), validateObjectId('userId'), transactionController.cancelPremiumPlan);
transactionRouter.post('/add-funds', authenticate, authorize('admin'), walletLimiter, transactionController.addFunds);

module.exports = transactionRouter;
