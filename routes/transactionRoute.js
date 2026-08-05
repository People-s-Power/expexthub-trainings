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

// Payment plan endpoints (student/client only)
const paymentPlanController = require('../controllers/paymentPlanController.js');
transactionRouter.post('/course-payment-plans', authenticate, authorize('student', 'client'), paymentLimiter, validateObjectId('courseId'), paymentPlanController.createPlan);
transactionRouter.get('/course-payment-plans', authenticate, authorize('student', 'client'), generalLimiter, paymentPlanController.listPlans);
transactionRouter.get('/course-payment-plans/:planId', authenticate, authorize('student', 'client'), validateObjectId('planId'), generalLimiter, paymentPlanController.getPlan);
transactionRouter.post('/course-payment-plans/:planId/installments/:number/initialize', authenticate, authorize('student', 'client'), paymentLimiter, validateObjectId('planId'), paymentPlanController.initializeInstallment);
transactionRouter.post('/course-payment-plans/:planId/installments/:number/pay-with-wallet', authenticate, authorize('student', 'client'), walletLimiter, validateObjectId('planId'), paymentPlanController.payInstallmentWithWallet);

// Admin-only operations
transactionRouter.post('/cancel-premium/:userId', authenticate, authorize('admin'), validateObjectId('userId'), transactionController.cancelPremiumPlan);
transactionRouter.post('/add-funds', authenticate, authorize('admin'), walletLimiter, transactionController.addFunds);

module.exports = transactionRouter;
