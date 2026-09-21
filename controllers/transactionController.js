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
const {
  settleAmbiguousTransfer,
  handleTransferEvent,
  executeWithdrawal,
  TRANSFER_FAILURES,
} = require('../services/withdrawalService.js');
const { buildAutoPayoutUpdate, serializeAutoPayout } = require('../services/autoPayoutService.js');
const { finalizeWalletFunding } = require('../services/walletFundingService.js');
const { verifyCharge, isChargeConfirmed } = require('../services/flutterwaveGateway.js');

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
 * Resolves a STUDENT whose wallet a provider may credit.
 *
 * Deliberately a separate resolver from `resolveWalletTarget`: that one answers
 * "may this request act on this wallet as its owner?", which a provider funding a
 * student's wallet is not. Here the caller is a third party depositing money, so
 * the checks are about the *recipient* being a legitimate destination rather than
 * about ownership. Keeping them apart is what stops a body-supplied id from
 * turning the owner path into an arbitrary-wallet write.
 *
 * The role list matches the learner roles everywhere else in the codebase
 * (`student` and `client` — see getStudents): the signup form posts "client" for
 * applicants, so admitting only `student` would refuse real learners.
 *
 * Returns { ok: true, user } or { ok: false, status, message }.
 */
async function resolveFundableStudent(studentId) {
  if (!isValidObjectId(studentId)) {
    return { ok: false, status: 400, message: 'Invalid student' };
  }

  const student = await User.findById(studentId);
  if (!student) {
    return { ok: false, status: 404, message: 'Student not found' };
  }
  if (!['student', 'client'].includes(student.role)) {
    return { ok: false, status: 400, message: 'Only a student wallet can be funded' };
  }
  if (student.blocked) {
    return { ok: false, status: 403, message: 'This student account cannot receive funds' };
  }

  return { ok: true, user: student };
}

// Withdrawal settlement (settleAmbiguousTransfer, the transfer-webhook handler,
// and the reconciliation sweep) lives in services/withdrawalService.js so the
// cron can reuse it without importing this HTTP controller.

// Wallet-funding settlement (finalizeWalletFunding) lives in
// services/walletFundingService.js for the same reason — the webhook branch, the
// redirect verifier below, and the payment reconciliation sweep all share it.

/**
 * Shared gate for "may this user start paying for this course right now?".
 * Returns an { status, message } problem, or null when the purchase may proceed.
 *
 * `renewal` inverts the two enrollment checks rather than skipping them. A
 * renewal is only meaningful for somebody who is already on the course and whose
 * access has lapsed, so "already enrolled" and "course is full" are exactly the
 * conditions that must NOT reject it — while "never enrolled at all" must. Left
 * unhandled, a renewal would either be refused outright (the old behaviour, which
 * is why a lapsed student was charged and never renewed) or, worse, admit a
 * stranger as a fresh enrollment.
 */
async function checkPurchaseEligibility({ course, user, userId, renewal = false }) {
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

  if (renewal) {
    const enrollment = (course.enrollments || []).find(
      entry => String(entry.user) === String(userId),
    );
    if (!enrollment) {
      return { status: 400, message: 'You are not enrolled in this course' };
    }
    if (enrollment.status === 'active') {
      return { status: 409, message: 'This enrollment is already active' };
    }
    // Capacity is not re-checked: the seat is already this student's, and holding
    // it against them because the course filled up in the meantime would take away
    // access they are paying to restore.
    return null;
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
      // A renewal reuses this whole verified spine — gateway checkout, webhook,
      // redirect verifier, reconciliation sweep — so a lapsed student is charged
      // and re-credited through the same code path as a first enrollment instead
      // of the unverified inline charge that used to leave the provider unpaid.
      const renewal = req.body.renewal === true;
      const [course, user] = await Promise.all([Course.findById(courseId), User.findById(userId)]);

      const problem = await checkPurchaseEligibility({ course, user, userId, renewal });
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
        'metadata.renewal': renewal,
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
        metadata: { title: course.title, courseFeeSnapshot: amount, renewal },
      });

      const link = await initializeGatewayCheckout({
        txRef,
        amount,
        customer: { email: user.email, name: user.fullname, phone: user.phone },
        description: `${renewal ? 'Renewal of' : 'Enrollment for'} ${course.title}`,
        meta: { userId: String(userId), courseId: String(courseId), renewal: String(renewal) },
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

        // Verify against the gateway through the shared helper (see
        // services/flutterwaveGateway.js) so the redirect path, the webhook, and
        // the reconciliation sweep all confirm a charge identically.
        const { ok: gatewayOk, payment, notFound } = await verifyCharge({
          gatewayTransactionId: gatewayId,
          txRef: transaction.txRef,
        });
        // 404 means Flutterwave has no record of this charge yet: genuinely
        // pending rather than an outage, so let the client keep polling.
        if (notFound) {
          return res.status(409).json({ message: 'Payment is still pending confirmation', code: 'PENDING' });
        }

        // Every field is re-checked against our own record: a matching reference is
        // not enough, the amount and currency must also be what we charged.
        const isConfirmed = gatewayOk && isChargeConfirmed(payment, transaction);

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

    const body = req.body || {};
    const eventType = String(body.event || '');
    const payment = body.data;
    if (!payment) return res.sendStatus(200); // Nothing actionable; don't ask for a retry.

    // Transfer (withdrawal payout) events are asynchronous and carry `reference`
    // plus an uppercase status instead of the `tx_ref` a charge carries, so they
    // must be routed to the withdrawal reconciler before the charge path below —
    // which keys on tx_ref and would otherwise drop them.
    if (eventType.startsWith('transfer') || (!payment.tx_ref && payment.reference && payment.status)) {
      try {
        await handleTransferEvent(body);
        return res.sendStatus(200);
      } catch (error) {
        console.error('Flutterwave transfer webhook processing failed:', error);
        return res.sendStatus(500); // Let Flutterwave retry transient failures.
      }
    }

    if (!payment.tx_ref) return res.sendStatus(200); // Nothing actionable; don't ask for a retry.

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
    // `renewal` is the whole reason this path is reachable for a lapsed student:
    // it swaps the "already enrolled" rejection for "must be enrolled and
    // inactive" (see checkPurchaseEligibility).
    const renewal = req.body.renewal === true;
    try {
      const [course, user] = await Promise.all([Course.findById(courseId), User.findById(userId)]);

      const problem = await checkPurchaseEligibility({ course, user, userId, renewal });
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
        metadata: { courseFeeSnapshot: amount, renewal },
      });

      try {
        const granted = await grantCourseAccess({ userId, courseId, renewal });
        // A renewal that matched no lapsed enrollment means the access was already
        // restored — by a second tab, a retried request, or a concurrent card
        // payment. Charging for it and stopping here would take the money and give
        // nothing back, so the debit is released and the caller told why.
        if (renewal && !granted) {
          await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
          await Transaction.updateOne(
            { _id: transaction._id },
            { $set: { status: 'failed', 'metadata.refunded': true, 'metadata.refundReason': 'enrollment_already_active' } },
          );
          return res.status(409).json({ message: 'This enrollment is already active' });
        }
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

      return res.json({
        message: renewal
          ? 'Payment successful and course enrollment renewed'
          : 'Payment successful and course enrollment confirmed',
        courseId,
        renewal,
      });
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

      // Who is being funded. Three modes, in priority order:
      //
      //  * a provider funding a STUDENT — `studentId` names somebody other than
      //    the caller, so it is resolved and authorized separately (below);
      //  * self-service — no target, or a target matching the caller;
      //  * a delegated team member impersonating a provider, which
      //    `resolveWalletTarget` already vets against the membership privileges.
      const actorId = String(req.user?.id || req.user?._id);
      const requestedStudentId = req.body.studentId;

      let user;
      // Non-null only for the provider→student mode. It is both the proof that
      // the actor is a third party (which selects the wallet-transfer branch) and
      // the provenance stamped on the ledger row so the provider can read back
      // the fundings they made.
      let fundedBy = null;

      if (requestedStudentId && String(requestedStudentId) !== actorId) {
        // A third party is depositing, so the actor's own privilege is the gate —
        // not the recipient's. `canFundWallet` passes ordinary tutors/providers
        // and admins, and requires an accepted membership granting "Fund Wallet"
        // from a team member.
        const actor = await User.findById(actorId).select('role teamMembers');
        if (!actor || !['tutor', 'provider', 'admin', 'team_member'].includes(actor.role)) {
          return res.status(403).json({ message: 'You do not have permission to fund a student wallet' });
        }
        if (!canFundWallet(actor)) {
          return res.status(403).json({ message: 'You do not have permission to fund a student wallet' });
        }

        const student = await resolveFundableStudent(requestedStudentId);
        if (!student.ok) {
          return res.status(student.status).json({ message: student.message });
        }
        user = student.user;
        fundedBy = actorId;
      } else {
        const { ok, user: owner } = await resolveWalletTarget(req, 'Fund Wallet', req.body.userId);
        if (!ok || !canFundWallet(owner)) {
          return res.status(403).json({ message: 'You do not have permission to fund the wallet' });
        }
        user = owner;
      }
      const userId = user._id;

      // Paying from the provider's own balance is an internal transfer between two
      // wallets on this platform, so it settles here instead of through a checkout
      // — there is no gateway leg to wait on. Only reachable in provider→student
      // mode; funding your own wallet from your own balance would be a no-op.
      if (fundedBy && req.body.paymentMethod === 'wallet') {
        // Conditional debit, exactly as `payWith` does it: two concurrent spends
        // cannot both match on the same balance, so the wallet cannot go negative.
        const debited = await User.findOneAndUpdate(
          { _id: fundedBy, balance: { $gte: amount } },
          { $inc: { balance: -amount } },
          { new: true },
        );
        if (!debited) {
          return res.status(400).json({ message: 'Insufficient wallet balance' });
        }

        let credited;
        try {
          credited = await User.findByIdAndUpdate(userId, { $inc: { balance: amount } }, { new: true });
        } catch (creditError) {
          // The student's credit is the whole point of the transfer, so if it
          // fails the debit must not stand — put the provider's money back and
          // report the failure rather than silently keeping it.
          await User.findByIdAndUpdate(fundedBy, { $inc: { balance: amount } });
          console.error('Wallet transfer credit failed, debit reversed:', creditError);
          return res.status(500).json({ message: 'Transfer failed. Your balance has not been charged.' });
        }

        // One reference links the two legs; `txRef` stays unique per row because
        // the schema indexes it that way.
        const transferRef = `wallet-transfer-${fundedBy}-${crypto.randomUUID()}`;
        await Transaction.create([
          {
            userId: fundedBy,
            amount,
            type: 'wallet_transfer_out',
            direction: 'debit',
            balanceAfter: debited.balance,
            status: 'successful',
            currency: 'NGN',
            txRef: `${transferRef}-out`,
            reference: transferRef,
            metadata: { purpose: 'provider_student_funding', fundedTo: String(userId) },
          },
          {
            userId,
            amount,
            type: 'wallet_funding',
            direction: 'credit',
            balanceAfter: credited?.balance ?? null,
            status: 'successful',
            paidAt: new Date(),
            currency: 'NGN',
            txRef: `${transferRef}-in`,
            reference: transferRef,
            metadata: { purpose: 'provider_student_funding', fundedBy },
          },
        ]);

        return res.status(200).json({
          message: 'Student wallet funded successfully',
          balance: credited?.balance ?? null,
          reference: transferRef,
        });
      }

      // Reuse a still-open checkout so repeated clicks or a tab return do not
      // stack several pending charges for the same amount.
      const openTransaction = await Transaction.findOne({
        userId,
        type: 'wallet_funding',
        status: 'pending',
        amount,
        // Scoped to the same funder. A student's own abandoned checkout must not
        // be handed to a provider as "yours" — the money would land correctly,
        // but the row would lose the fundedBy provenance this feature reads back.
        // A null matches rows with no funder, which is exactly the self-service case.
        'metadata.fundedBy': fundedBy,
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
        metadata: {
          purpose: fundedBy ? 'provider_student_funding' : 'wallet_funding',
          ...(fundedBy ? { fundedBy } : {}),
          redirect_url: req.body.redirect_url,
        },
      });

      const link = await initializeGatewayCheckout({
        txRef,
        amount,
        customer: { email: user.email, name: user.fullname, phone: user.phone },
        description: fundedBy ? 'Student wallet funding' : 'Wallet funding',
        meta: { userId: String(userId), purpose: 'wallet_funding', ...(fundedBy ? { fundedBy } : {}) },
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
      const { ok: gatewayOk, payment, notFound } = await verifyCharge({
        gatewayTransactionId: gatewayId,
        txRef: transaction.txRef,
      });
      if (notFound) {
        return res.status(409).json({ message: 'Payment is still pending confirmation', code: 'PENDING' });
      }

      const isConfirmed = gatewayOk && isChargeConfirmed(payment, transaction);

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
        },
        // Shipped with the balance so the wallet renders the schedule without a
        // second round trip; the dedicated endpoint exists for updates and polls.
        autoPayout: serializeAutoPayout(user)
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

      // Hold-then-transfer lives in withdrawalService so a scheduled auto payout
      // takes the identical path; this endpoint only maps the outcome to a status.
      const result = await executeWithdrawal({ user, amount, source: 'manual' });

      if (result.outcome === 'no_account') return res.status(400).json({ message: result.message });
      if (result.outcome === 'insufficient') return res.status(400).json({ message: result.message });
      // A withdrawal requested moments ago is still holding the money, so a second
      // one is refused rather than queued as a duplicate payout.
      if (result.outcome === 'in_progress') return res.status(409).json({ message: result.message });
      if (result.outcome === 'successful') return res.status(200).json({ message: result.message });
      if (result.outcome === 'refunded') return res.status(502).json({ message: result.message });
      return res.status(202).json({ message: result.message });
    } catch (error) {
      console.error('Error during withdrawal:', error.response?.data || error.message);
      return res.status(500).json({ message: 'Withdrawal failed. Please try again.' });
    }
  },

  /**
   * Read the wallet's payout schedule. Same authorization as viewing the wallet,
   * since the schedule only describes money that is already visible there.
   */
  getAutoPayout: async (req, res) => {
    try {
      const { ok, user } = await resolveWalletTarget(req, 'View Wallet', req.query.userId);
      if (!ok || !canAccessWallet(user)) {
        return res.status(403).json({ message: 'You do not have permission to view this wallet' });
      }
      return res.status(200).json({
        autoPayout: serializeAutoPayout(user),
        hasPayoutAccount: Boolean(user.bankCode && user.accountNumber),
      });
    } catch (error) {
      console.error('Get auto payout failed:', error.message);
      return res.status(500).json({ message: 'Unable to load the payout schedule' });
    }
  },

  /**
   * Create or change the payout schedule.
   *
   * Gated on "Withdraw from Wallet", not "View Wallet": scheduling a payout moves
   * money, so anyone who can set it must already be allowed to withdraw. Enabling
   * without a saved payout account is refused up front rather than failing later
   * at transfer time with no one watching.
   */
  updateAutoPayout: async (req, res) => {
    try {
      const { ok, user } = await resolveWalletTarget(req, 'Withdraw from Wallet', req.body.userId);
      if (!ok || !canWithdrawWallet(user)) {
        return res.status(403).json({ message: 'You do not have permission to manage payouts' });
      }

      const update = buildAutoPayoutUpdate(req.body, user.autoPayout);
      if (update.enabled && !(user.bankCode && user.accountNumber)) {
        return res.status(400).json({ message: 'Add your payout bank account before turning on automatic payouts' });
      }

      user.autoPayout = { ...(user.autoPayout?.toObject?.() || user.autoPayout || {}), ...update };
      await user.save();

      return res.status(200).json({
        message: update.enabled ? 'Automatic payouts are on' : 'Automatic payouts are off',
        autoPayout: serializeAutoPayout(user),
      });
    } catch (error) {
      console.error('Update auto payout failed:', error.message);
      return res.status(500).json({ message: 'Unable to save the payout schedule' });
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

  /**
   * The fundings this provider has made into student wallets, newest first.
   *
   * This exists instead of reading the student's wallet through `getBalance`,
   * which is deliberately restricted to the owner and admins. Widening that would
   * expose a student's entire financial history to any provider; this returns only
   * the rows the caller themselves created, keyed on the `metadata.fundedBy`
   * provenance stamped at funding time.
   *
   * Pending rows are included on purpose — a checkout that has not settled yet is
   * exactly the status the provider needs to see.
   */
  listFundedStudents: async (req, res) => {
    try {
      const actorId = String(req.user?.id || req.user?._id);

      const fundings = await Transaction.find({
        'metadata.fundedBy': actorId,
        type: 'wallet_funding',
      })
        .sort({ date: -1 })
        .limit(100)
        .lean();

      if (fundings.length === 0) {
        return res.status(200).json({ fundings: [] });
      }

      // One lookup for every student on the page rather than a findById per row.
      const studentIds = [...new Set(fundings.map((entry) => String(entry.userId)))];
      const students = await User.find({ _id: { $in: studentIds } })
        .select('name fullname email')
        .lean();
      const byId = new Map(students.map((student) => [String(student._id), student]));

      return res.status(200).json({
        fundings: fundings.map((entry) => {
          const student = byId.get(String(entry.userId));
          return {
            _id: entry._id,
            studentId: entry.userId,
            studentName: student?.name || student?.fullname || 'Student',
            studentEmail: student?.email || null,
            amount: entry.amount,
            status: entry.status,
            txRef: entry.txRef,
            reference: entry.reference || null,
            date: entry.date,
            paidAt: entry.paidAt || null,
            // Lets the provider reopen a checkout that is still awaiting payment.
            checkoutLink: entry.metadata?.checkoutLink || null,
          };
        }),
      });
    } catch (error) {
      console.error('List funded students failed:', error);
      return res.status(500).json({ message: 'Unable to retrieve funded students' });
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
