const express = require('express');
const transactionRouter = express.Router();
const transactionController = require('../controllers/transactionController.js')
const authenticate = require('../middlewares/auth.js');

transactionRouter.get("/balance/:userId", transactionController.getBalance);
transactionRouter.get('/banks', transactionController.getBanks)
transactionRouter.put('/verify-account', transactionController.verifyAccount)
transactionRouter.post('/create-recipient', transactionController.createRecipient)
transactionRouter.post('/withdraw', transactionController.withdraw)
transactionRouter.post('/cancel-premium/:userId', transactionController.cancelPremiumPlan)

transactionRouter.post('/add-funds', transactionController.addFunds)
transactionRouter.post('/pay-with', authenticate, transactionController.payWith)
transactionRouter.post('/initialize-course-payment', authenticate, transactionController.initializeCoursePayment)
transactionRouter.post('/pay-course-with-wallet', authenticate, transactionController.payCourseWithWallet)
transactionRouter.get('/verify/:txRef', transactionController.verifyCoursePayment)
transactionRouter.post('/webhook', transactionController.flutterwaveWebhook)

const paymentPlanController = require('../controllers/paymentPlanController.js');
transactionRouter.post('/course-payment-plans', authenticate, paymentPlanController.createPlan)
transactionRouter.get('/course-payment-plans', authenticate, paymentPlanController.listPlans)
transactionRouter.get('/course-payment-plans/:planId', authenticate, paymentPlanController.getPlan)
transactionRouter.post('/course-payment-plans/:planId/installments/:number/initialize', authenticate, paymentPlanController.initializeInstallment)
transactionRouter.post('/course-payment-plans/:planId/installments/:number/pay-with-wallet', authenticate, paymentPlanController.payInstallmentWithWallet)


module.exports = transactionRouter;
