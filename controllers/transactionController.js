const Transaction = require("../models/transactions.js");
const User = require("../models/user.js");
const axios = require("axios");
const Course = require("../models/courses.js");
const crypto = require("crypto");
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const PaymentWebhookEvent = require('../models/paymentWebhookEvents.js');
const { sendPaymentReceiptOnce } = require('../utils/emails/receiptDispatcher.js');
const { isValidObjectId, parseAmount } = require('../middlewares/validateRequest.js');
const {
  finalizeFullCoursePayment,
  finalizeInstallmentPayment,
  grantCourseAccess,
  creditInstructor,
  initializeGatewayCheckout,
  CHECKOUT_REUSE_WINDOW_MS,
} = require('../services/coursePaymentService.js');

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';

const flwHeaders = { Authorization: `Bearer ${flutterwaveSecretKey}` };
const GATEWAY_TIMEOUT_MS = 20000;

// Wallet ledger policy. Amounts are stored in major units (naira), matching the
// course-payment convention and what the wallet history renders.
const WALLET_MIN_WITHDRAWAL = 500;
const WALLET_MAX_WITHDRAWAL = 5000000;
const WALLET_MAX_FUNDING = 5000000;

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
 * Wallet access for team members is delegated: the member's privileges are stored
 * on their OWN user document in teamMembers[] (authController's add-team flow
 * pushes the same { ownerId, tutorId, memberRole, status, privileges } object onto
 * both the owner's and the member's docs). The member keeps their own JWT while
 * acting for the provider that added them, so the wallet controllers read the
 * requester's stored user rather than the token claims.
 *
 * Admin and the wallet owner (tutor/provider) always pass. A team_member passes
 * only when an accepted membership grants the privilege. Every other role manages
 * their own wallet and is unaffected.
 */
function walletPrivilegeGranted(user, privilege) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'team_member') return true; // tutor/provider/student/client self-service
  return (user.teamMembers || []).some(
    (entry) =>
      entry?.status === 'accepted' &&
      Array.isArray(entry?.privileges) &&
      entry.privileges.some((p) => p?.value === privilege && p?.checked === true),
  );
}

function canAccessWallet(user) {
  return walletPrivilegeGranted(user, 'View Wallet');
}

function canWithdrawWallet(user) {
  return walletPrivilegeGranted(user, 'Withdraw from Wallet');
}

function canFundWallet(user) {
  return walletPrivilegeGranted(user, 'Fund Wallet');
}

/**
 * Resolves the user whose wallet this request may act on, and loads that user.
 *
 * Self-service is the default: no target supplied (or a target matching the
 * actor) acts on the caller's own wallet, and their own stored privileges are
 * the gate. A delegated team member impersonating a provider (the sidebar flow
 * swaps the dashboard's user id to the provider's while the member keeps their
 * own JWT) may act on that provider's wallet, and only that provider's: the
 * request must name the owner, the actor must hold an accepted membership with
 * that owner, and the membership must grant `privilege`. Every other role
 * acting on somebody else's id is rejected, so a body-supplied userId can
 * never redirect a wallet operation onto a stranger.
 *
 * Returns { ok: true, user } with the target owner document, or { ok: false }.
 */
async function resolveWalletTarget(req, privilege, requestedTargetId) {
  const actorId = String(req.user?.id || req.user?._id);
  const targetId = requestedTargetId && String(requestedTargetId) !== actorId
    ? String(requestedTargetId)
    : actorId;

  if (targetId === actorId) {
    const user = await User.findById(actorId);
    return user ? { ok: true, user } : { ok: false };
  }

  const actor = await User.findById(actorId).select('role teamMembers');
  if (!actor || actor.role !== 'team_member') return { ok: false };

  const membership = (actor.teamMembers || []).find(
    (entry) => String(entry.ownerId) === targetId && entry.status === 'accepted',
  );
  const granted = membership && Array.isArray(membership.privileges)
    && membership.privileges.some((p) => p?.value === privilege && p?.checked === true);
  if (!granted) return { ok: false };

  const owner = await User.findById(targetId);
  return owner ? { ok: true, user: owner } : { ok: false };
}

/**
 * Resolves an ambiguous transfer failure (timeout/5xx where the gateway may
 * still have accepted the transfer) without paying out twice.
 *
 * The transfer is looked up by reference: confirmed-successful marks the
 * withdrawal complete; confirmed-failed (or no transfer row, i.e. the request
 * was rejected before a transfer existed) refunds the hold; anything still
 * pending keeps the hold so reconciliation can finish the job.
 *
 * Returns 'successful' | 'refunded' | 'pending'.
 */
async function settleAmbiguousTransfer(userId, transaction, amount, reference) {
  try {
    const statusResponse = await axios.get(`${flutterwaveBaseURL}transfers`, {
      params: { reference },
      headers: flwHeaders,
      timeout: GATEWAY_TIMEOUT_MS,
    });
    const rows = statusResponse.data?.data;
    const transfer = Array.isArray(rows) ? rows.find((row) => row?.reference === reference) : null;

    if (transfer?.status === 'SUCCESSFUL') {
      await Transaction.updateOne({ _id: transaction._id }, {
        $set: { status: 'successful', gatewayTransactionId: transfer.id ? String(transfer.id) : undefined },
      });
      return 'successful';
    }
    if (transfer && ['FAILED', 'FAILED_FUNDS', 'FAILED_DISBURSE'].includes(transfer.status)) {
      await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
      await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
      return 'refunded';
    }
    if (!transfer) {
      // No row exists for this reference: the original call never created a
      // transfer, so releasing the hold cannot double-pay.
      await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
      await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
      return 'refunded';
    }
    return 'pending';
  } catch (error) {
    console.error('Withdrawal status check failed:', error.response?.data || error.message);
    return 'pending';
  }
}

/**
 * Finalizes a wallet-funding payment: flips the still-pending Transaction to
 * successful and credits the wallet once.
 *
 * Idempotency comes from the conditional status update — only the first caller
 * (webhook or redirect verification) whose filter still matches performs the
 * write, and only that winner increments the balance. Replays no-op.
 *
 * The amount/currency cross-check against Flutterwave happens in the caller
 * (verifyWalletFunding / the webhook branch) before this is invoked.
 */
async function finalizeWalletFunding(txRef, gatewayPayment) {
  const transaction = await Transaction.findOne({ txRef });
  if (!transaction || transaction.type !== 'wallet_funding') {
    console.error('Wallet funding: transaction not found for', txRef);
    return false;
  }

  const updated = await Transaction.findOneAndUpdate(
    { _id: transaction._id, status: 'pending' },
    {
      $set: {
        status: 'successful',
        paidAt: transaction.paidAt || new Date(),
        ...(gatewayPayment?.id ? { gatewayTransactionId: String(gatewayPayment.id) } : {}),
      },
    },
    { new: true },
  );
  if (!updated) return true; // Already finalized (webhook/redirect replay).

  const user = await User.findById(updated.userId);
  if (!user) {
    console.error('Wallet funding: user not found for', String(updated.userId), 'txRef', txRef);
    return true;
  }

  const preCredit = Number(user.balance) || 0;
  const credited = await User.findByIdAndUpdate(
    updated.userId,
    { $inc: { balance: Number(updated.amount) } },
    { new: true },
  );
  // Record the running balance so the ledger reconciles line-by-line.
  await Transaction.updateOne({ _id: updated._id }, { $set: { balanceAfter: preCredit + Number(updated.amount) } });

  console.log('Wallet funded:', txRef, 'amount', updated.amount, 'balanceAfter', credited?.balance);
  return true;
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
  // A machine-readable code lets the client open its verification flow instead of
  // string-matching this message.
  if (!user.isVerified) return { status: 403, message: 'Please verify your email before paying', code: 'EMAIL_NOT_VERIFIED' };
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
    // An untouched plan is just an abandoned intent, so it must not block paying
    // in full. Retire it and let the full payment proceed. A plan with money
    // against it is a real balance and has to be settled through the plan.
    if (Number(existingPlan.amountPaidMinor) > 0 || (existingPlan.installments || []).some(entry => entry.status === 'processing')) {
      return {
        status: 409,
        message: 'You already have a part payment plan for this course. Continue from your outstanding balance.',
        code: 'PLAN_EXISTS',
        planId: existingPlan._id,
      };
    }
    await CoursePaymentPlan.updateOne(
      { _id: existingPlan._id, amountPaidMinor: 0, status: { $in: ['pending', 'active', 'overdue'] } },
      { $set: { status: 'cancelled' } },
    );
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

      const link = await initializeGatewayCheckout({
        txRef,
        amount,
        customer: { email: user.email, name: user.fullname, phone: user.phone },
        description: `Enrollment for ${course.title}`,
        meta: { userId: String(userId), courseId: String(courseId) },
        redirectUrl: req.body.redirect_url,
      });

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

      // Wallet funding uses its own txRef prefix so the webhook can route it to
      // the wallet finalizer without touching the course-payment path. Same dedupe
      // (PaymentWebhookEvent above), same amount/currency cross-check, and the
      // credit itself is guarded by the conditional status update.
      if (String(payment.tx_ref).startsWith('wallet-fund-')) {
        const walletTransaction = await Transaction.findOne({
          txRef: payment.tx_ref,
          type: 'wallet_funding',
        });
        if (walletTransaction) {
          const isWalletConfirmed = payment.status === 'successful'
            && Number(payment.amount) >= Number(walletTransaction.amount)
            && payment.currency === walletTransaction.currency;
          if (isWalletConfirmed) {
            await finalizeWalletFunding(walletTransaction.txRef, payment);
          } else if (payment.status === 'failed' || payment.status === 'cancelled') {
            await Transaction.updateOne({ _id: walletTransaction._id, status: 'pending' }, { $set: { status: 'failed' } });
          } else {
            console.error('Webhook wallet funding did not match our record:', {
              txRef: payment.tx_ref,
              gatewayAmount: payment.amount,
              expectedAmount: walletTransaction.amount,
              gatewayCurrency: payment.currency,
              expectedCurrency: walletTransaction.currency,
            });
          }
        }
        if (event) {
          event.status = 'processed';
          event.processedAt = new Date();
          await event.save();
        }
        return res.sendStatus(200);
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
        direction: 'debit',
        balanceAfter: chargedUser.balance,
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

      // Wallet full-payments never touch the gateway finalizer, so the receipt
      // is dispatched here. Fire-and-forget; never fail a completed purchase on
      // a mail error.
      sendPaymentReceiptOnce({ transaction, settledInFull: true, paymentMethod: 'Wallet' });

      return res.json({ message: 'Payment successful and course enrollment confirmed', courseId });
    } catch (error) {
      console.error('Course wallet payment failed:', error);
      return res.status(500).json({ message: 'Wallet payment failed. Please try again.' });
    }
  },
  fundWallet: async (req, res) => {
    let transaction;
    try {
      const amount = parseAmount(req.body.amount);

      if (amount === null) {
        return res.status(400).json({ message: 'Enter a valid amount' });
      }
      if (amount > WALLET_MAX_FUNDING) {
        return res.status(400).json({ message: `Amount cannot exceed ${WALLET_MAX_FUNDING}` });
      }

      // The wallet being funded. Self-service by default; a delegated team
      // member impersonating a provider may fund that provider's wallet when
      // the membership grants "Fund Wallet".
      const { ok, user } = await resolveWalletTarget(req, 'Fund Wallet', req.body.userId);
      if (!ok || !canFundWallet(user)) {
        return res.status(403).json({ message: 'You do not have permission to fund the wallet' });
      }
      const userId = user._id;

      // Reuse a still-open checkout so repeated clicks or a tab return do not
      // stack several pending charges for the same amount.
      const openTransaction = await Transaction.findOne({
        userId,
        type: 'wallet_funding',
        status: 'pending',
        amount,
        'metadata.checkoutLink': { $exists: true },
        date: { $gte: new Date(Date.now() - CHECKOUT_REUSE_WINDOW_MS) },
      }).sort({ date: -1 });
      if (openTransaction?.metadata?.checkoutLink) {
        return res.status(200).json({ link: openTransaction.metadata.checkoutLink, txRef: openTransaction.txRef, reused: true });
      }

      const txRef = `wallet-fund-${userId}-${crypto.randomUUID()}`;
      transaction = await Transaction.create({
        userId,
        amount,
        type: 'wallet_funding',
        direction: 'credit',
        status: 'pending',
        currency: 'NGN',
        txRef,
        metadata: { purpose: 'wallet_funding', redirect_url: req.body.redirect_url },
      });

      const link = await initializeGatewayCheckout({
        txRef,
        amount,
        customer: { email: user.email, name: user.fullname, phone: user.phone },
        description: 'Wallet funding',
        meta: { userId: String(userId), purpose: 'wallet_funding' },
        redirectUrl: req.body.redirect_url,
      });

      await Transaction.updateOne({ _id: transaction._id }, { $set: { 'metadata.checkoutLink': link } });
      return res.status(201).json({ link, txRef });
    } catch (error) {
      if (transaction) await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
      console.error('Wallet funding initialization failed:', error.response?.data || error.message);
      return res.status(502).json({ message: 'Unable to start payment. Please try again.' });
    }
  },

  verifyWalletFunding: async (req, res) => {
    try {
      const { txRef } = req.params;
      if (!txRef || typeof txRef !== 'string' || txRef.length > 200 || !txRef.startsWith('wallet-fund-')) {
        return res.status(400).json({ message: 'Invalid payment reference' });
      }

      const transaction = await Transaction.findOne({ txRef });
      if (!transaction || transaction.type !== 'wallet_funding') {
        return res.status(404).json({ message: 'Payment not found' });
      }

      if (transaction.status === 'failed') {
        return res.status(400).json({ message: 'This payment did not go through. Please start a new payment.' });
      }
      if (transaction.status === 'successful') {
        const current = await User.findById(transaction.userId);
        return res.json({ message: 'Payment confirmed', balance: current?.balance ?? null });
      }

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
        if (lookupError.response?.status === 404) {
          return res.status(409).json({ message: 'Payment is still pending confirmation', code: 'PENDING' });
        }
        throw lookupError;
      }

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

      await finalizeWalletFunding(transaction.txRef, payment);
      const user = await User.findById(transaction.userId);
      return res.json({ message: 'Payment confirmed', balance: user?.balance ?? null });
    } catch (error) {
      console.error('Wallet funding verification failed:', error.response?.data || error.message);
      return res.status(502).json({ message: 'Payment confirmation is temporarily unavailable. Please try again.' });
    }
  },

  getBalance: async (req, res) => {
    const { userId } = req.params;
    const authenticatedUserId = req.user?.id || req.user?._id;

    try {
      // Users can only view their own wallet unless they're an admin (admin
      // keeps the historical any-wallet view). A delegated team member acting
      // for the provider that added them may view that provider's wallet, but
      // only when the membership grants "View Wallet".
      const isAdmin = req.user?.role === 'admin';
      if (String(authenticatedUserId) !== String(userId) && !isAdmin) {
        const delegated = await resolveWalletTarget(req, 'View Wallet', userId);
        if (!delegated.ok) {
          return res.status(403).json({ message: 'You can only view your own wallet' });
        }
      }

      const [user, requester] = await Promise.all([
        User.findById(userId),
        User.findById(authenticatedUserId).select('role teamMembers'),
      ]);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Team members must hold the "View Wallet" privilege to see their wallet.
      if (!canAccessWallet(requester)) {
        return res.status(403).json({ message: 'You do not have permission to view the wallet' });
      }

      const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(100);

      res.json({
        balance: user.balance,
        transactions,
        user: {
          bankCode: user.bankCode,
          accountNumber: user.accountNumber,
          accountName: user.accountName
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
    // Bank details are written to the wallet owner this request acts on.
    // Self-service by default. A delegated team member impersonating a provider
    // may save the provider's payout account, but only when the request names
    // that provider and the membership grants "Withdraw from Wallet" — a
    // body-supplied userId can never repoint someone else's payout account at
    // the actor's own bank details.
    const { bankCode, accountNumber } = req.body;

    try {
      if (!bankCode || !accountNumber) {
        return res.status(400).json({ message: 'Bank code and account number are required' });
      }
      if (!/^\d{10}$/.test(String(accountNumber))) {
        return res.status(400).json({ message: 'Account number must be 10 digits' });
      }

      const { ok, user } = await resolveWalletTarget(req, 'Withdraw from Wallet', req.body.userId);
      if (!ok || !canWithdrawWallet(user)) {
        return res.status(403).json({ message: 'You do not have permission to manage the payout account' });
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
      user.accountName = resolvedName;
      await user.save();

      return res.status(200).json({ message: 'Payout account saved', accountName: resolvedName });
    } catch (error) {
      console.error('Error creating recipient:', error.response?.data || error.message);
      return res.status(500).json({ message: 'Unable to save payout account' });
    }
  },

  withdraw: async (req, res) => {
    const amount = parseAmount(req.body.amount);

    try {
      if (amount === null) {
        return res.status(400).json({ message: 'Invalid withdrawal amount' });
      }
      if (amount < WALLET_MIN_WITHDRAWAL) {
        return res.status(400).json({ message: `Minimum withdrawal is ${WALLET_MIN_WITHDRAWAL}` });
      }
      if (amount > WALLET_MAX_WITHDRAWAL) {
        return res.status(400).json({ message: `Maximum withdrawal is ${WALLET_MAX_WITHDRAWAL}` });
      }

      // The wallet the money leaves. Self-service by default; a delegated team
      // member impersonating a provider may withdraw from that provider's
      // wallet when the membership grants "Withdraw from Wallet".
      const { ok, user } = await resolveWalletTarget(req, 'Withdraw from Wallet', req.body.userId);
      if (!ok || !canWithdrawWallet(user)) {
        return res.status(403).json({ message: 'You do not have permission to withdraw from the wallet' });
      }
      if (!user.bankCode || !user.accountNumber) {
        return res.status(400).json({ message: 'Please add your payout bank account first' });
      }

      const userId = user._id;

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

      const reference = `wd-${crypto.randomUUID()}`;
      const transaction = await Transaction.create({
        userId: user._id,
        amount,
        type: 'debit',
        direction: 'debit',
        balanceAfter: debited.balance,
        status: 'pending',
        txRef: reference,
        reference,
        metadata: { purpose: 'withdrawal', accountName: user.accountName || null, bankCode: user.bankCode, accountNumber: user.accountNumber },
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
        // A timeout or 5xx does not prove the transfer failed — the gateway may
        // have accepted it and lost the response on the way back, in which case
        // refunding the hold would pay the amount out twice. Resolve the
        // transfer by reference before releasing the funds.
        const outcome = await settleAmbiguousTransfer(userId, transaction, amount, reference);
        console.error('Withdrawal transfer failed:', transferError.response?.data || transferError.message);
        if (outcome === 'successful') {
          return res.status(200).json({ message: 'Withdrawal successful' });
        }
        if (outcome === 'refunded') {
          return res.status(502).json({ message: 'Withdrawal could not be completed. Your balance was not affected.' });
        }
        // Still settling at the gateway: keep the hold and let reconciliation
        // finish it rather than risking a double payout.
        return res.status(202).json({ message: 'Your withdrawal is being processed. It will reflect shortly.' });
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
        direction: 'credit',
        balanceAfter: user.balance,
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
        direction: 'debit',
        balanceAfter: user.balance,
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
