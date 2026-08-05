const Transaction = require("../models/transactions.js");
const User = require("../models/user.js");
const axios = require("axios");
const Course = require("../models/courses.js");
const crypto = require("crypto");
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const PaymentWebhookEvent = require('../models/paymentWebhookEvents.js');
const {
  finalizeFullCoursePayment,
  finalizeInstallmentPayment,
  grantCourseAccess,
  creditInstructor,
} = require('../services/coursePaymentService.js');

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';

const flwHeaders = { Authorization: `Bearer ${flutterwaveSecretKey}` };

const transactionController = {
  initializeCoursePayment: async (req, res) => {
    let transaction;
    try {
      const userId = req.user.id;
      const { courseId, redirect_url } = req.body;
      const [course, user] = await Promise.all([Course.findById(courseId), User.findById(userId)]);
      if (!course) return res.status(404).json({ message: 'Course not found' });
      if (!user || !['student', 'client'].includes(user.role)) return res.status(403).json({ message: 'Only students can enroll' });
      if (!user.isVerified) return res.status(403).json({ message: 'Please verify your email before paying' });
      if (course.enrolledStudents.some(id => String(id) === String(user._id))) return res.status(409).json({ message: 'Student is already enrolled in the course' });
      const existingPlan = await CoursePaymentPlan.findOne({ userId, courseId, status: { $in: ['pending', 'active', 'overdue'] } });
      if (existingPlan) return res.status(409).json({ message: 'You already have an installment plan for this course. Continue with your next installment.' });
      const amount = Number(course.fee || 0);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'This course does not require payment' });

      const txRef = `course-${course._id}-${user._id}-${crypto.randomUUID()}`;
      transaction = await Transaction.create({ userId, courseId, amount, txRef, type: 'course_payment', status: 'pending', currency: 'NGN', metadata: { title: course.title } });
      const response = await axios.post(`${flutterwaveBaseURL}payments`, {
        tx_ref: txRef, amount, currency: 'NGN', redirect_url: redirect_url || process.env.FRONTEND_URL,
        customer: { email: user.email, name: user.fullname, phonenumber: user.phone || undefined },
        customizations: { title: 'ExpertHub Training', description: `Enrollment for ${course.title}` },
        meta: { userId: String(userId), courseId: String(courseId) },
      }, { headers: flwHeaders });
      if (response.data?.status !== 'success' || !response.data?.data?.link) throw new Error('Payment gateway did not return a checkout link');
      return res.status(201).json({ link: response.data.data.link, txRef });
    } catch (error) {
      if (transaction) await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
      console.error('Course payment initialization failed:', error.response?.data || error.message);
      return res.status(502).json({ message: 'Unable to start payment. Please try again.' });
    }
  },

  verifyCoursePayment: async (req, res) => {
    try {
      const transaction = await Transaction.findOne({ txRef: req.params.txRef });
      if (!transaction || !['course_payment', 'course_installment'].includes(transaction.type)) return res.status(404).json({ message: 'Payment not found' });
      if (transaction.status !== 'successful') {
        const gatewayId = req.query.id || transaction.gatewayTransactionId;
        if (!gatewayId) return res.status(409).json({ message: 'Payment is still pending' });
        const response = await axios.get(`${flutterwaveBaseURL}transactions/${gatewayId}/verify`, { headers: flwHeaders });
        const payment = response.data?.data;
        if (response.data?.status !== 'success' || payment?.status !== 'successful' || payment?.tx_ref !== transaction.txRef || Number(payment.amount) !== Number(transaction.amount) || payment.currency !== transaction.currency) return res.status(400).json({ message: 'Payment could not be confirmed' });
        if (transaction.type === 'course_installment') await finalizeInstallmentPayment(transaction, payment);
        else await finalizeFullCoursePayment(transaction, payment);
      } else if (transaction.type === 'course_installment') {
        await finalizeInstallmentPayment(transaction);
      } else {
        await finalizeFullCoursePayment(transaction);
      }
      return res.json({ message: 'Payment confirmed', courseId: transaction.courseId, paymentPlanId: transaction.paymentPlanId || null });
    } catch (error) {
      console.error('Course payment verification failed:', error.response?.data || error.message);
      return res.status(502).json({ message: 'Payment confirmation is temporarily unavailable. Please try again.' });
    }
  },

  flutterwaveWebhook: async (req, res) => {
    if (!process.env.FLUTTERWAVE_WEBHOOK_HASH || req.headers['verif-hash'] !== process.env.FLUTTERWAVE_WEBHOOK_HASH) return res.sendStatus(401);
    const payment = req.body?.data;
    const eventId = payment?.id ? `flutterwave-${payment.id}` : `flutterwave-${payment?.tx_ref || crypto.randomUUID()}`;
    let event;
    try {
      const existingEvent = await PaymentWebhookEvent.findOne({ eventId });
      if (existingEvent?.status === 'processed') return res.sendStatus(200);
      event = existingEvent || await PaymentWebhookEvent.create({ eventId, payload: req.body });
      event.payload = req.body;
      event.status = 'received';
      await event.save();
      const transaction = await Transaction.findOne({ txRef: payment?.tx_ref, type: { $in: ['course_payment', 'course_installment'] } });
      if (!transaction || payment?.status !== 'successful' || Number(payment.amount) !== Number(transaction.amount) || payment.currency !== transaction.currency) {
        event.status = 'processed';
        event.processedAt = new Date();
        await event.save();
        return res.sendStatus(200);
      }
      if (transaction.type === 'course_installment') await finalizeInstallmentPayment(transaction, payment);
      else await finalizeFullCoursePayment(transaction, payment);
      event.status = 'processed';
      event.processedAt = new Date();
      await event.save();
      return res.sendStatus(200);
    } catch (error) {
      console.error('Flutterwave webhook processing failed:', error);
      if (event) {
        event.status = 'failed';
        event.error = error.message;
        await event.save().catch(saveError => console.error('Could not persist webhook failure:', saveError));
      }
      return res.sendStatus(500); // Let Flutterwave retry transient processing failures.
    }
  },
  payCourseWithWallet: async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    const { courseId } = req.body;
    try {
      const [course, user] = await Promise.all([Course.findById(courseId), User.findById(userId)]);
      if (!course) return res.status(404).json({ message: 'Course not found' });
      if (!user || !['student', 'client'].includes(user.role)) return res.status(403).json({ message: 'Only students can enroll' });
      if (course.enrolledStudents.some(id => String(id) === String(userId))) return res.status(409).json({ message: 'Student is already enrolled in the course' });
      const amount = Number(course.fee || 0);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'This course does not require payment' });
      const chargedUser = await User.findOneAndUpdate({ _id: userId, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
      if (!chargedUser) return res.status(400).json({ message: 'Insufficient wallet balance' });
      const transaction = await Transaction.create({ userId, courseId, amount, type: 'course_payment_wallet', status: 'successful', currency: 'NGN', txRef: `course-wallet-${courseId}-${userId}-${crypto.randomUUID()}` });
      try {
        await grantCourseAccess({ userId, courseId });
        await creditInstructor(transaction, amount);
      } catch (error) {
        await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
        await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
        throw error;
      }
      return res.json({ message: 'Payment successful and course enrollment confirmed', courseId });
    } catch (error) {
      console.error('Course wallet payment failed:', error);
      return res.status(500).json({ message: 'Wallet payment failed. Please try again.' });
    }
  },
  getBalance: async (req, res) => {
    const { userId } = req.params;

    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }

      const transactions = await Transaction.find({ userId: user._id });

      res.json({
        balance: user.balance,
        transactions,
        user: {
          bankCode: user.bankCode,
          accountNumber: user.accountNumber
        }
      });
    } catch (error) {
      res.status(500).send('Internal Server Error');
    }
  },

  getBanks: async (req, res) => {
    try {
      const response = await axios.get(`${flutterwaveBaseURL}banks/NG`, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });
      // console.log(response)
      res.status(200).json({
        message: response.data.message,
        data: response.data.data
      });

    } catch (error) {
      console.error('Error during verification:', error.response ? error.response.data : error.message);
      res.status(500).send('Internal Server Error');
    }
  },

  verifyAccount: async (req, res) => {
    const { accountNumber, bankCode } = req.body
    try {
      const response = await axios.post(`${flutterwaveBaseURL}accounts/resolve`, {
        account_number: accountNumber,
        account_bank: bankCode,
      }, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });
      // console.log(response.data.data)

      res.status(200).json({
        message: response.data.message,
        data: response.data.data.account_name
      });
      //   });

    } catch (error) {
      console.error('Error during verification:', error.response ? error.response.data : error.message);
      res.status(500).send('Internal Server Error');
    }
  },

  cancelPremiumPlan: async (req, res) => {
    const userId = req.params.userId

    try {

      const user = await User.findById(userId)
      console.log(user.flutterwaveSubscriptionId);

      if (!user) {
        return res.status(404).json({ message: "User not found" })
      }

      if (!user.premiumPlan || user.premiumPlan === "basic") {
        return res.status(400).json({ message: "No active premium plan to cancel" })
      }


      user.premiumPlan = "basic"

      try {
        // Make API call to Flutterwave to cancel subscription
        const response = await axios.put(
          `${flutterwaveBaseURL}subscriptions/${user.flutterwaveSubscriptionId}/cancel`,
          {},
          {
            headers: {
              Authorization: `Bearer ${flutterwaveSecretKey}`,
            },
          },
        )

        console.log("Flutterwave cancellation response:", response.data)

        // Clear the subscription ID
        user.flutterwaveSubscriptionId = null
      } catch (flwError) {
        // Log the error but continue with local cancellation
        console.error(
          "Error canceling Flutterwave subscription:",
          flwError.response ? flwError.response.data : flwError.message,
        )
      }


      // Save the updated user
      await user.save()

      // Create a record in transaction history
      await Transaction.create({
        userId: user._id,
        type: "subscription_cancellation",
        amount: 0,
      })

      // Send success response
      return res.status(200).json({
        message:
          "Your premium plan has been canceled successfully. You will have access until the end of your current billing period.",
      })
    } catch (error) {
      console.error("Error canceling premium plan:", error)
      return res.status(500).json({ message: "Internal server error" })
    }
  },
  createRecipient: async (req, res) => {
    const { userId, bankCode, accountNumber } = req.body;

    try {
      const user = await User.findById(userId);

      user.bankCode = bankCode;
      user.accountNumber = accountNumber
      await user.save();
      if (!user) {
        return res.status(404).send('User not found');
      }

      const response = await axios.post(`${flutterwaveBaseURL}beneficiaries`, {
        account_bank: bankCode,
        account_number: accountNumber,
        currency: 'NGN',
        beneficiary_name: user.fullname,
      }, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });

      // console.log(response.data.data)

      res.status(200).json({ message: 'Recipient created', recipientCode: user.flutterwaveRecipientCode });
    } catch (error) {
      console.error('Error creating recipient:', error.response ? error.response.data : error.message);
      res.status(500).send('Internal Server Error');
    }
  },

  withdraw: async (req, res) => {
    const { userId, amount } = req.body;

    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }

      if (user.balance < amount) {
        return res.status(400).send('Insufficient balance');
      }

      const response = await axios.post(`${flutterwaveBaseURL}transfers`, {
        account_bank: user.bankCode,
        account_number: user.accountNumber, // You should store the user's account number
        amount,
        narration: 'Withdrawal',
        currency: 'NGN',
        reference: `tx-${Date.now()}`
      }, {
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
        },
      });

      if (response.data.status === 'success') {
        // Deduct amount from user balance

        user.balance -= amount;
        await user.save();

        await Transaction.create({
          userId: user._id,
          amount: amount,
          type: 'debit'
        })

        return res.status(200).json({ message: 'Withdrawal successful' });
      }

      res.status(200).json({ message: response.data.message });
    } catch (error) {
      console.error('Error during withdrawal:', error.response ? error.response.data : error.message);
      res.status(500).send(error.response.data.message);
    }
  },

  addFunds: async (req, res) => {
    const { userId, amount } = req.body;
    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }

      user.balance += amount;
      await user.save();

      await Transaction.create({
        userId: user._id,
        amount: amount,
        type: 'credit'
      })

      return res.status(200).json({ message: 'Funds Added successfully' });
    } catch (error) {
      // console.error('Error during withdrawal:', error.response ? error.response.data : error.message);
      res.status(500).send(error.response.data.message);
    }
  },

  payWith: async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    const amount = Number(req.body.amount);
    try {
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).send('Invalid payment amount');
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).send('User not found');
      }
      if (user.balance < amount) {
        return res.status(400).send('Insufficient balance');
      }

      user.balance -= amount;
      await user.save();

      await Transaction.create({
        userId: user._id,
        amount: amount,
        type: 'debit'
      })

      return res.status(200).json({ message: 'Payment Made successfully' });

    } catch (error) {
      res.status(500).send(error.response.data.message);
    }
  }
}


module.exports = transactionController;
