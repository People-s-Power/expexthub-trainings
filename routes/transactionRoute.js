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
transactionRouter.post('/pay-with', transactionController.payWith)
transactionRouter.post('/initialize-course-payment', authenticate, transactionController.initializeCoursePayment)
transactionRouter.get('/verify/:txRef', transactionController.verifyCoursePayment)
transactionRouter.post('/webhook', transactionController.flutterwaveWebhook)


module.exports = transactionRouter;
