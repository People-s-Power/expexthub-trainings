const Transaction = require("../models/transactions.js");
const User = require("../models/user.js");
const axios = require("axios");
const Course = require("../models/courses.js");
const crypto = require("crypto");
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const PaymentWebhookEvent = require('../models/paymentWebhookEvents.js');
const { isValidObjectId, parseAmount } = require('../middlewares/validateRequest.js');
const {
  finalizeFullCoursePayment,
  finalizeInstallmentPayment,
  grantCourseAccess,
  creditInstructor,
} = require('../services/coursePaymentService.js');

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';

const flwHeaders = { Authorization: `Bearer ${flutterwaveSecretKey}` };
const GATEWAY_TIMEOUT_MS = 20000;

/** Constant-time string comparison that tolerates unequal lengths. */
function safeCompare(a, b) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Still perform a comparison so the timing does not reveal the length.
    crypto.timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Only allow redirect targets we own, so a caller cannot turn our checkout into
 * an open redirect that hands a payment reference to an attacker's page.
 */
function resolveRedirectUrl(requested) {
  const allowed = [process.env.FRONTEND_URL, process.env.TRAINING_URL]
    .filter(Boolean)
    .map(value => value.replace(/\/$/, ''));

  if (!requested) return allowed[0];

  try {
    const target = new URL(requested);
    const isAllowed = allowed.some(base => {
      try {
        return new URL(base).origin === target.origin;
      } catch {
        return false;
      }
    });
    return isAllowed ? requested : allowed[0];
  } catch {
    return allowed[0];
  }
}

/**
 * Shared gate for "may this user start paying for this course right now?".
 * Returns an { status, message } problem, or null when the purchase may proceed.
 */
async function checkPurchaseEligibility({ course, user, userId }) {
  if (!course) return { status: 404, message: 'Course not found' };
  if (!user) return { status: 404, message: 'User not found' };
  if (user.blocked) return { status: 403, message: 'Your account is not permitted to enroll' };
  if (!['student', 'client'].includes(user.role)) return { status: 403, message: 'Only students can enroll' };
  if (!user.isVerified) return { status: 403, message: 'Please verify your email before paying' };
  if (!course.approved) return { status: 403, message: 'This course is not open for enrollment yet' };
  if (String(course.instructorId) === String(userId)) return { status: 400, message: 'You cannot enroll in your own course' };
  if (course.enrollmentDeadline && new Date(course.enrollmentDeadline) < new Date()) {
    return { status: 409, message: 'Enrollment for this course has closed' };
  }
  if ((course.enrolledStudents || []).some(id => String(id) === String(userId))) {
    return { status: 409, message: 'Student is already enrolled in the course' };
  }
  if (course.capacity && (course.enrolledStudents || []).length >= course.capacity) {
    return { status: 409, message: 'This course is full' };
  }

  const existingPlan = await CoursePaymentPlan.findOne({
    userId,
    courseId: course._id,
    status: { $in: ['pending', 'active', 'overdue'] },
  });
  if (existingPlan) {
    return {
      status: 409,
      message: 'You already have an installment plan for this course. Continue with your next installment.',
      code: 'PLAN_EXISTS',
      planId: existingPlan._id,
    };
  }

  return null;
}

const transactionController = {
  initializeCoursePayment: async (req, res) => {
    let transaction;
    try {
      const userId = req.user.id;
      const { courseId } = req.body;
      const [course, user] = await Promise.all([Course.findById(courseId), User.findById(userId)]);

      const problem = await checkPurchaseEligibility({ course, user, userId });
      if (problem) {
        const { status, ...body } = problem;
        return res.status(status).json(body);
      }

      const amount = Number(course.fee || 0);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'This course does not require payment' });

      // Reuse a still-open checkout instead of stacking pending charges when a
      // student clicks Enrol repeatedly or returns to the tab.
      const openTransaction = await Transaction.findOne({
        userId,
        courseId,
        type: 'course_payment',
        status: 'pending',
        amount,
        'metadata.checkoutLink': { $exists: true },
        date: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
      }).sort({ date: -1 });
      if (openTransaction?.metadata?.checkoutLink) {
        return res.status(200).json({ link: openTransaction.metadata.checkoutLink, txRef: openTransaction.txRef, reused: true });
      }

      const txRef = `course-${course._id}-${user._id}-${crypto.randomUUID()}`;
      transaction = await Transaction.create({
        userId,
        courseId,
        amount,
        txRef,
        type: 'course_payment',
        status: 'pending',
        currency: 'NGN',
        metadata: { title: course.title, courseFeeSnapshot: amount },
      });

      const response = await axios.post(`${flutterwaveBaseURL}payments`, {
        tx_ref: txRef,
        amount,
        currency: 'NGN',
        redirect_url: resolveRedirectUrl(req.body.redirect_url),
        customer: { email: user.email, name: user.fullname, phonenumber: user.phone || undefined },
        customizations: { title: 'ExpertHub Training', description: `Enrollment for ${course.title}` },
        meta: { userId: String(userId), courseId: String(courseId) },
      }, { headers: flwHeaders, timeout: GATEWAY_TIMEOUT_MS });

      const link = response.data?.data?.link;
      if (response.data?.status !== 'success' || !link) throw new Error('Payment gateway did not return a checkout link');

      await Transaction.updateOne({ _id: transaction._id }, { $set: { 'metadata.checkoutLink': link } });
      return res.status(201).json({ link, txRef });
    } catch (error) {
      if (transaction) await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
      console.error('Course payment initialization failed:', error.response?.data || error.message);
      return res.status(502).json({ message: 'Unable to start payment. Please try again.' });
    }
  },

  verifyCoursePayment: async (req, res) => {
    try {
      const { txRef } = req.params;
      if (!txRef || typeof txRef !== 'string' || txRef.length > 200) {
        return res.status(400).json({ message: 'Invalid payment reference' });
      }

      const transaction = await Transaction.findOne({ txRef });
      if (!transaction || !['course_payment', 'course_installment'].includes(transaction.type)) {
        return res.status(404).json({ message: 'Payment not found' });
      }

      // The gateway redirect is unauthenticated, so ownership is not asserted here.
      // Safety comes from the reference being an unguessable UUID and from the
      // outcome being derived solely from Flutterwave's own verification response —
      // a third party replaying this URL can only re-confirm a payment that already
      // succeeded, and the response body exposes nothing about the payer.
      if (transaction.status === 'failed') {
        return res.status(400).json({ message: 'This payment did not go through. Please start a new payment.' });
      }

      if (transaction.status !== 'successful') {
        // Flutterwave's Standard redirect carries `transaction_id`; some older
        // integrations send `id`. Accept either, and when neither is present fall
        // back to verifying by our own reference — confirmation must never
        // dead-end just because a query parameter was named differently.
        const gatewayId = req.query.transaction_id || req.query.id || transaction.gatewayTransactionId;

        let payment;
        let gatewayOk = false;
        try {
          const response = gatewayId
            ? await axios.get(`${flutterwaveBaseURL}transactions/${encodeURIComponent(gatewayId)}/verify`, {
                headers: flwHeaders,
                timeout: GATEWAY_TIMEOUT_MS,
              })
            : await axios.get(`${flutterwaveBaseURL}transactions/verify_by_reference`, {
                params: { tx_ref: transaction.txRef },
                headers: flwHeaders,
                timeout: GATEWAY_TIMEOUT_MS,
              });
          payment = response.data?.data;
          gatewayOk = response.data?.status === 'success';
        } catch (lookupError) {
          // 404 means Flutterwave has no record of this charge yet: genuinely
          // pending rather than an outage, so let the client keep polling.
          if (lookupError.response?.status === 404) {
            return res.status(409).json({ message: 'Payment is still pending confirmation', code: 'PENDING' });
          }
          throw lookupError;
        }

        // Every field is re-checked against our own record: a matching reference is
        // not enough, the amount and currency must also be what we charged.
        const isConfirmed = gatewayOk
          && payment?.status === 'successful'
          && payment?.tx_ref === transaction.txRef
          && Number(payment.amount) >= Number(transaction.amount)
          && payment.currency === transaction.currency;

        if (!isConfirmed) {
          if (payment?.status === 'failed' || payment?.status === 'cancelled') {
            await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
            return res.status(400).json({ message: 'This payment did not go through. Please start a new payment.' });
          }
          return res.status(409).json({ message: 'Payment is still pending confirmation', code: 'PENDING' });
        }

        if (transaction.type === 'course_installment') await finalizeInstallmentPayment(transaction, payment);
        else await finalizeFullCoursePayment(transaction, payment);
      } else if (transaction.type === 'course_installment') {
        // Already successful: re-run finalization, which is idempotent, so a
        // webhook that credited the payment but failed to enrol self-heals.
        await finalizeInstallmentPayment(transaction);
      } else {
        await finalizeFullCoursePayment(transaction);
      }

      return res.json({
        message: 'Payment confirmed',
        courseId: transaction.courseId,
        paymentPlanId: transaction.paymentPlanId || null,
      });
    } catch (error) {
      console.error('Course payment verification failed:', error.response?.data || error.message);
      return res.status(502).json({ message: 'Payment confirmation is temporarily unavailable. Please try again.' });
    }
  },

  flutterwaveWebhook: async (req, res) => {
    const expectedHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;
    const providedHash = req.headers['verif-hash'];

    if (!expectedHash) {
      console.error('FLUTTERWAVE_WEBHOOK_HASH is not configured; rejecting webhook.');
      return res.sendStatus(401);
    }
    // Constant-time comparison so the secret cannot be recovered by timing the
    // response to repeated guesses.
    if (!providedHash || !safeCompare(String(providedHash), String(expectedHash))) {
      return res.sendStatus(401);
    }

    const payment = req.body?.data;
    if (!payment?.tx_ref) return res.sendStatus(200); // Nothing actionable; don't ask for a retry.

    const eventId = payment.id ? `flutterwave-${payment.id}` : `flutterwave-${payment.tx_ref}`;
    let event;
    try {
      // Claim the event atomically. Two simultaneous deliveries of the same event
      // cannot both proceed: the loser hits the unique index and returns 200.
      try {
        event = await PaymentWebhookEvent.create({ eventId, payload: req.body, status: 'received' });
      } catch (createError) {
        if (createError?.code !== 11000) throw createError;
        const existing = await PaymentWebhookEvent.findOne({ eventId });
        if (existing?.status === 'processed') return res.sendStatus(200);
        // A prior attempt failed mid-flight; retry it. Finalization is idempotent.
        event = existing;
        if (event) {
          event.payload = req.body;
          event.status = 'received';
          await event.save();
        }
      }

      const transaction = await Transaction.findOne({
        txRef: payment.tx_ref,
        type: { $in: ['course_payment', 'course_installment'] },
      });

      // Amount is compared with >= so an overpayment still enrols rather than
      // stranding a student who was genuinely charged.
      const isActionable = transaction
        && payment.status === 'successful'
        && Number(payment.amount) >= Number(transaction.amount)
        && payment.currency === transaction.currency;

      if (!isActionable) {
        if (transaction && (payment.status === 'failed' || payment.status === 'cancelled')) {
          await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
        } else if (transaction) {
          // Mismatched amount/currency on a successful charge is a real anomaly
          // worth investigating rather than silently discarding.
          console.error('Webhook payment did not match our record:', {
            txRef: payment.tx_ref,
            gatewayAmount: payment.amount,
            expectedAmount: transaction.amount,
            gatewayCurrency: payment.currency,
            expectedCurrency: transaction.currency,
          });
        }
        if (event) {
          event.status = 'processed';
          event.processedAt = new Date();
          await event.save();
        }
        return res.sendStatus(200);
      }

      if (transaction.type === 'course_installment') await finalizeInstallmentPayment(transaction, payment);
      else await finalizeFullCoursePayment(transaction, payment);

      if (event) {
        event.status = 'processed';
        event.processedAt = new Date();
        await event.save();
      }
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

      const problem = await checkPurchaseEligibility({ course, user, userId });
      if (problem) {
        const { status, ...body } = problem;
        return res.status(status).json(body);
      }

      const amount = Number(course.fee || 0);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'This course does not require payment' });

      // Debit atomically so two concurrent wallet-pay calls cannot both pass a
      // balance check and spend twice against the same balance.
      const chargedUser = await User.findOneAndUpdate(
        { _id: userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true },
      );
      if (!chargedUser) return res.status(400).json({ message: 'Insufficient wallet balance' });

      const txRef = `course-wallet-${courseId}-${userId}-${crypto.randomUUID()}`;
      const transaction = await Transaction.create({
        userId,
        courseId,
        amount,
        type: 'course_payment_wallet',
        status: 'successful',
        currency: 'NGN',
        txRef,
        paidAt: new Date(),
        metadata: { courseFeeSnapshot: amount },
      });

      try {
        await grantCourseAccess({ userId, courseId });
        await creditInstructor(transaction, amount);
      } catch (error) {
        // Refund the wallet debit if enrollment or credit fails; otherwise the
        // student has paid but remains unenrolled.
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
    const authenticatedUserId = req.user?.id || req.user?._id;

    try {
      // Users can only view their own balance unless they're admin
      if (String(authenticatedUserId) !== String(userId) && req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'You can only view your own balance' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(100);

      res.json({
        balance: user.balance,
        transactions,
        user: {
          bankCode: user.bankCode,
          accountNumber: user.accountNumber
        }
      });
    } catch (error) {
      console.error('Get balance failed:', error);
      res.status(500).json({ message: 'Unable to retrieve balance' });
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
    // Bank details are always written to the authenticated user's own account.
    // Trusting a body-supplied userId here would let anyone repoint another
    // user's payout account at their own bank account.
    const userId = req.user?.id || req.user?._id;
    const { bankCode, accountNumber } = req.body;

    try {
      if (!bankCode || !accountNumber) {
        return res.status(400).json({ message: 'Bank code and account number are required' });
      }
      if (!/^\d{10}$/.test(String(accountNumber))) {
        return res.status(400).json({ message: 'Account number must be 10 digits' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Confirm the account actually exists and belongs to a real name before
      // storing it, so withdrawals do not fail later at transfer time.
      let resolvedName;
      try {
        const resolution = await axios.post(`${flutterwaveBaseURL}accounts/resolve`, {
          account_number: String(accountNumber),
          account_bank: String(bankCode),
        }, { headers: flwHeaders });
        resolvedName = resolution.data?.data?.account_name;
      } catch (resolveError) {
        console.error('Account resolution failed:', resolveError.response?.data || resolveError.message);
        return res.status(400).json({ message: 'Could not verify this bank account. Please check the details.' });
      }
      if (!resolvedName) {
        return res.status(400).json({ message: 'Could not verify this bank account. Please check the details.' });
      }

      user.bankCode = String(bankCode);
      user.accountNumber = String(accountNumber);
      await user.save();

      return res.status(200).json({ message: 'Payout account saved', accountName: resolvedName });
    } catch (error) {
      console.error('Error creating recipient:', error.response?.data || error.message);
      return res.status(500).json({ message: 'Unable to save payout account' });
    }
  },

  withdraw: async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    const amount = parseAmount(req.body.amount);

    try {
      if (amount === null) {
        return res.status(400).json({ message: 'Invalid withdrawal amount' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (!user.bankCode || !user.accountNumber) {
        return res.status(400).json({ message: 'Please add your payout bank account first' });
      }

      // Debit first, conditionally on sufficient funds, so two concurrent
      // withdrawal requests cannot both pass a balance check and overdraw.
      const debited = await User.findOneAndUpdate(
        { _id: userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true },
      );
      if (!debited) {
        return res.status(400).json({ message: 'Insufficient balance' });
      }

      const reference = `withdraw-${userId}-${crypto.randomUUID()}`;
      const transaction = await Transaction.create({
        userId: user._id,
        amount,
        type: 'debit',
        status: 'pending',
        txRef: reference,
        metadata: { purpose: 'withdrawal' },
      });

      try {
        const response = await axios.post(`${flutterwaveBaseURL}transfers`, {
          account_bank: user.bankCode,
          account_number: user.accountNumber,
          amount,
          narration: 'Withdrawal',
          currency: 'NGN',
          reference,
        }, { headers: flwHeaders });

        if (response.data?.status !== 'success') {
          throw new Error(response.data?.message || 'Transfer was not accepted');
        }

        await Transaction.updateOne({ _id: transaction._id }, {
          $set: { status: 'successful', gatewayTransactionId: response.data?.data?.id ? String(response.data.data.id) : undefined },
        });
        return res.status(200).json({ message: 'Withdrawal successful' });
      } catch (transferError) {
        // Refund the hold so a failed transfer never silently eats the balance.
        await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
        await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
        console.error('Withdrawal transfer failed:', transferError.response?.data || transferError.message);
        return res.status(502).json({ message: 'Withdrawal could not be completed. Your balance was not affected.' });
      }
    } catch (error) {
      console.error('Error during withdrawal:', error.response?.data || error.message);
      return res.status(500).json({ message: 'Withdrawal failed. Please try again.' });
    }
  },

  addFunds: async (req, res) => {
    // Admin-only credit (route enforces the role). Kept for manual reconciliation;
    // it must never be reachable by a student, or the wallet becomes free money.
    const { userId } = req.body;
    const amount = parseAmount(req.body.amount);
    try {
      if (!isValidObjectId(userId)) {
        return res.status(400).json({ message: 'Invalid userId' });
      }
      if (amount === null) {
        return res.status(400).json({ message: 'Invalid amount' });
      }

      const user = await User.findByIdAndUpdate(userId, { $inc: { balance: amount } }, { new: true });
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      await Transaction.create({
        userId: user._id,
        amount,
        type: 'credit',
        status: 'successful',
        txRef: `admin-credit-${userId}-${crypto.randomUUID()}`,
        metadata: { creditedBy: String(req.user?.id || req.user?._id), purpose: 'manual_credit' },
      });

      return res.status(200).json({ message: 'Funds added successfully', balance: user.balance });
    } catch (error) {
      console.error('Add funds failed:', error);
      return res.status(500).json({ message: 'Unable to add funds' });
    }
  },

  payWith: async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    const amount = parseAmount(req.body.amount);
    try {
      if (amount === null) return res.status(400).json({ message: 'Invalid payment amount' });

      // Conditional debit: prevents two concurrent spends from both succeeding
      // against the same balance.
      const user = await User.findOneAndUpdate(
        { _id: userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true },
      );
      if (!user) {
        return res.status(400).json({ message: 'Insufficient balance' });
      }

      await Transaction.create({
        userId: user._id,
        amount,
        type: 'debit',
        status: 'successful',
        txRef: `wallet-debit-${userId}-${crypto.randomUUID()}`,
      });

      return res.status(200).json({ message: 'Payment Made successfully', balance: user.balance });
    } catch (error) {
      console.error('Wallet payment failed:', error);
      return res.status(500).json({ message: 'Payment failed. Please try again.' });
    }
  }
}


module.exports = transactionController;
