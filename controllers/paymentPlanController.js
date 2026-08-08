const crypto = require('crypto');
const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Transaction = require('../models/transactions.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const {
  toMinorUnits,
  toMajorUnits,
  serializePlan,
  refreshDueStatus,
  finalizeInstallmentPayment,
  planOutstandingMinor,
  nextPaymentNumber,
  validatePaymentAmount,
  openPlanForStudent,
  resolvePartPaymentPolicy,
  FULL_PAYMENT_TYPES,
  initializeGatewayCheckout,
} = require('../services/coursePaymentService.js');

// A checkout link older than this is assumed abandoned, so the slot is released
// and a fresh charge can be started.
const CHECKOUT_REUSE_WINDOW_MS = 30 * 60 * 1000;

function authenticatedUserId(req) {
  return req.user?.id || req.user?._id;
}

function responsePlan(plan) {
  return { plan: serializePlan(plan) };
}

async function getOwnedPlan(req, res) {
  const userId = authenticatedUserId(req);
  // Scoping the query by userId is what prevents one student from reading or
  // paying against another student's plan by guessing the planId.
  const plan = await CoursePaymentPlan.findOne({ _id: req.params.planId, userId });
  if (!plan) {
    res.status(404).json({ message: 'Payment plan not found' });
    return null;
  }
  if (refreshDueStatus(plan)) await plan.save();
  return plan;
}

async function validateStudent(userId) {
  const user = await User.findById(userId);
  if (!user || !['student', 'client'].includes(user.role)) throw Object.assign(new Error('Only students can pay for courses'), { status: 403 });
  if (user.blocked) throw Object.assign(new Error('Your account is not permitted to enroll'), { status: 403 });
  if (!user.isVerified) {
    throw Object.assign(new Error('Please verify your email before paying'), { status: 403, code: 'EMAIL_NOT_VERIFIED' });
  }
  return user;
}

/**
 * Releases checkout slots the student walked away from.
 *
 * The gateway charge itself is not cancelled — it cannot be — but the webhook
 * settles by payment number regardless of the local status, so a late completion
 * still credits correctly. Returns true when the plan was modified.
 */
async function releaseStalePayments(plan) {
  const stale = (plan.installments || []).filter(entry => {
    if (entry.status !== 'processing') return false;
    const startedAt = entry.lastAttemptAt ? new Date(entry.lastAttemptAt).getTime() : 0;
    return Date.now() - startedAt > CHECKOUT_REUSE_WINDOW_MS;
  });
  if (!stale.length) return false;

  for (const entry of stale) {
    entry.status = 'failed';
    if (entry.txRef) {
      await Transaction.updateOne({ txRef: entry.txRef, status: 'pending' }, { $set: { status: 'failed' } });
    }
  }
  await plan.save();
  return true;
}

const paymentPlanController = {
  listPlans: async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const plans = await CoursePaymentPlan.find({ userId, status: { $ne: 'cancelled' } }).sort({ updatedAt: -1 });
      const changedPlans = plans.filter(refreshDueStatus);
      if (changedPlans.length) await Promise.all(changedPlans.map(plan => plan.save()));
      return res.json({ plans: plans.map(serializePlan) });
    } catch (error) {
      console.error('List payment plans failed:', error);
      return res.status(500).json({ message: 'Unable to load payment plans' });
    }
  },

  createPlan: async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const user = await validateStudent(userId);
      const course = await Course.findById(req.body.courseId);
      if (!course) return res.status(404).json({ message: 'Course not found' });
      if (!course.approved) return res.status(403).json({ message: 'This course is not open for enrollment yet' });
      if (String(course.instructorId) === String(userId)) return res.status(400).json({ message: 'You cannot enroll in your own course' });
      if (course.enrollmentDeadline && new Date(course.enrollmentDeadline) < new Date()) {
        return res.status(409).json({ message: 'Enrollment for this course has closed' });
      }
      if (course.capacity && (course.enrolledStudents || []).length >= course.capacity) {
        return res.status(409).json({ message: 'This course is full' });
      }

      // The instructor decides whether this course may be paid for in parts.
      // Checked here as well as in openPlanForStudent so a student who somehow
      // reaches this endpoint for a full-payment-only course gets a straight
      // answer instead of a generic failure. Anyone already part-way through a
      // plan is handled below — openPlanForStudent honours committed money
      // regardless of the current setting.
      const { partPaymentEnabled } = resolvePartPaymentPolicy(course);
      const livePlan = await CoursePaymentPlan.findOne({
        userId,
        courseId: course._id,
        status: { $in: ['pending', 'active', 'overdue'] },
      });
      const isMidPlan = Number(livePlan?.amountPaidMinor || 0) > 0
        || (livePlan?.installments || []).some(entry => entry.status === 'processing');
      if (!partPaymentEnabled && !isMidPlan) {
        return res.status(403).json({
          message: 'This course must be paid for in full.',
          code: 'PART_PAYMENT_DISABLED',
        });
      }

      // A student who already paid in full must not be able to open a plan on top.
      const paidInFull = await Transaction.findOne({
        userId,
        courseId: course._id,
        type: { $in: FULL_PAYMENT_TYPES },
        status: 'successful',
      });
      if (paidInFull) return res.status(409).json({ message: 'You have already paid for this course' });

      // Enrollment alone is not a blocker here: a part-paid student is enrolled
      // and still needs to come back and clear their balance.
      const alreadyEnrolled = (course.enrolledStudents || []).some(id => String(id) === String(userId));
      const plan = await openPlanForStudent({ user, course });
      if (alreadyEnrolled && planOutstandingMinor(plan) <= 0) {
        return res.status(409).json({ message: 'Student is already enrolled in the course' });
      }

      return res.status(201).json({
        ...responsePlan(plan),
        customer: { email: user.email, name: user.fullname, phone: user.phone || undefined },
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message, code: error.code });
      if (error.code === 11000) return res.status(409).json({ message: 'A payment plan already exists for this course' });
      console.error('Create payment plan failed:', error);
      return res.status(500).json({ message: 'Unable to create payment plan' });
    }
  },

  getPlan: async (req, res) => {
    try {
      const plan = await getOwnedPlan(req, res);
      if (!plan) return;
      return res.json(responsePlan(plan));
    } catch (error) {
      console.error('Get payment plan failed:', error);
      return res.status(500).json({ message: 'Unable to load payment plan' });
    }
  },

  /**
   * Starts a gateway checkout for a student-chosen amount.
   *
   * The amount is validated server-side against the outstanding balance, the
   * minimum-payment policy and anything already in flight — the client's figure
   * is a request, never the authority.
   */
  initializePayment: async (req, res) => {
    let transaction;
    let plan;
    let paymentNumber;
    try {
      plan = await getOwnedPlan(req, res);
      if (!plan) return;

      const user = await validateStudent(authenticatedUserId(req));

      if (plan.status === 'completed') return res.status(409).json({ message: 'This course is already fully paid', plan: serializePlan(plan) });
      if (plan.status === 'cancelled') return res.status(409).json({ message: 'This payment plan has been cancelled' });

      await releaseStalePayments(plan);

      // Reuse a still-open checkout for the same amount instead of stacking charges
      // when a student clicks Pay twice or returns to the tab.
      const requestedMinor = toMinorUnits(req.body.amount);
      const openPayment = (plan.installments || []).find(entry => entry.status === 'processing' && entry.amountMinor === requestedMinor);
      if (openPayment?.txRef) {
        const existing = await Transaction.findOne({ txRef: openPayment.txRef, status: 'pending' });
        if (existing?.metadata?.checkoutLink) {
          return res.status(200).json({ link: existing.metadata.checkoutLink, txRef: existing.txRef, plan: serializePlan(plan), reused: true });
        }
      }

      const { amountMinor, error } = validatePaymentAmount(plan, req.body.amount);
      if (error) return res.status(400).json({ message: error, plan: serializePlan(plan) });

      paymentNumber = nextPaymentNumber(plan);
      const txRef = `course-plan-${plan._id}-${paymentNumber}-${crypto.randomUUID()}`;
      transaction = await Transaction.create({
        userId: plan.userId,
        courseId: plan.courseId,
        paymentPlanId: plan._id,
        installmentNumber: paymentNumber,
        amount: toMajorUnits(amountMinor),
        txRef,
        type: 'course_installment',
        status: 'pending',
        currency: plan.currency,
        metadata: { title: plan.priceSnapshot?.courseTitle, paymentNumber },
      });

      plan.installments.push({
        number: paymentNumber,
        amountMinor,
        status: 'processing',
        txRef,
        attempts: 1,
        lastAttemptAt: new Date(),
      });
      await plan.save();

      const outstandingAfter = toMajorUnits(Math.max(0, planOutstandingMinor(plan) - amountMinor));
      const link = await initializeGatewayCheckout({
        txRef,
        amount: transaction.amount,
        currency: transaction.currency,
        customer: { email: user.email, name: user.fullname, phone: user.phone },
        description: `Part payment for ${plan.priceSnapshot?.courseTitle || 'course'}${outstandingAfter > 0 ? ` (balance after: ${outstandingAfter})` : ' (final payment)'}`,
        meta: {
          userId: String(plan.userId),
          courseId: String(plan.courseId),
          paymentPlanId: String(plan._id),
          installmentNumber: paymentNumber,
        },
        redirectUrl: req.body.redirect_url,
      });

      transaction.metadata = { ...(transaction.metadata || {}), checkoutLink: link };
      await transaction.save();
      return res.status(201).json({ link, txRef, plan: serializePlan(plan) });
    } catch (error) {
      if (transaction) {
        await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
        if (plan && paymentNumber) {
          // Re-read before rolling back: the webhook may have already settled this
          // payment while the checkout call was failing on our side.
          const fresh = await CoursePaymentPlan.findById(plan._id);
          const freshPayment = fresh?.installments.find(item => item.number === paymentNumber);
          if (freshPayment?.status === 'processing') {
            freshPayment.status = 'failed';
            await fresh.save();
          }
        }
      }
      console.error('Part payment initialization failed:', error.response?.data || error.message);
      if (error.status) return res.status(error.status).json({ message: error.message, code: error.code });
      return res.status(502).json({ message: 'Unable to start payment. Please try again.' });
    }
  },

  payWithWallet: async (req, res) => {
    try {
      const plan = await getOwnedPlan(req, res);
      if (!plan) return;

      await validateStudent(authenticatedUserId(req));
      if (plan.status === 'cancelled') return res.status(409).json({ message: 'This payment plan has been cancelled' });
      if (plan.status === 'completed') return res.status(409).json({ message: 'This course is already fully paid', plan: serializePlan(plan) });

      await releaseStalePayments(plan);

      const { amountMinor, error } = validatePaymentAmount(plan, req.body.amount);
      if (error) return res.status(400).json({ message: error, plan: serializePlan(plan) });

      const amount = toMajorUnits(amountMinor);
      // Debit atomically so two concurrent calls cannot both pass a balance check
      // and spend the same funds twice.
      const user = await User.findOneAndUpdate(
        { _id: plan.userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true },
      );
      if (!user) return res.status(400).json({ message: 'Insufficient wallet balance' });

      const paymentNumber = nextPaymentNumber(plan);
      const txRef = `course-plan-wallet-${plan._id}-${paymentNumber}-${crypto.randomUUID()}`;
      let transaction;
      try {
        plan.installments.push({
          number: paymentNumber,
          amountMinor,
          status: 'processing',
          txRef,
          attempts: 1,
          lastAttemptAt: new Date(),
        });
        await plan.save();

        transaction = await Transaction.create({
          userId: plan.userId,
          courseId: plan.courseId,
          paymentPlanId: plan._id,
          installmentNumber: paymentNumber,
          amount,
          txRef,
          type: 'course_installment_wallet',
          status: 'successful',
          currency: plan.currency,
          paidAt: new Date(),
        });

        await finalizeInstallmentPayment(transaction);
      } catch (settlementError) {
        await User.findByIdAndUpdate(plan.userId, { $inc: { balance: amount } });
        if (transaction) await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
        throw settlementError;
      }

      const settled = await CoursePaymentPlan.findById(plan._id);
      const outstanding = toMajorUnits(planOutstandingMinor(settled));
      return res.json({
        message: outstanding > 0
          ? `Payment successful. ${outstanding} remaining on this course.`
          : 'Payment successful. This course is now fully paid.',
        plan: serializePlan(settled),
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message, code: error.code });
      console.error('Wallet part payment failed:', error);
      return res.status(500).json({ message: 'Wallet payment failed. Please try again.' });
    }
  },
};

module.exports = paymentPlanController;
