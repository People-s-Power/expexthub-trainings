const express = require('express');
const transactionRouter = express.Router();
const transactionController = require('../controllers/transactionController.js');
const authenticate = require('../middlewares/auth.js');
const authorize = require('../middlewares/authorize.js');
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

// Payment records for the admissions view. Tutors and admins both reach this;
// the controller scopes rows by course ownership, so a tutor only ever sees the
// money owed on their own courses.
const paymentRecordController = require('../controllers/paymentRecordController.js');
transactionRouter.get('/payment-records', authenticate, authorize('tutor', 'admin'), generalLimiter, paymentRecordController.listPaymentRecords);
transactionRouter.get('/payment-records/courses', authenticate, authorize('tutor', 'admin'), generalLimiter, paymentRecordController.listPaymentRecordCourses);

// Admin-only operations
transactionRouter.post('/cancel-premium/:userId', authenticate, authorize('admin'), validateObjectId('userId'), transactionController.cancelPremiumPlan);
transactionRouter.post('/add-funds', authenticate, authorize('admin'), walletLimiter, transactionController.addFunds);

module.exports = transactionRouter;
