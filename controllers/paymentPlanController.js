const crypto = require('crypto');
const axios = require('axios');
const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Transaction = require('../models/transactions.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const {
  toMinorUnits,
  toMajorUnits,
  serializePlan,
  buildInstallments,
  refreshDueStatus,
  finalizeInstallmentPayment,
  creditInstructor,
  grantCourseAccess,
  resolveInstallmentPolicy,
} = require('../services/coursePaymentService.js');

const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';
const flwHeaders = { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET}` };
const GATEWAY_TIMEOUT_MS = 20000;
// A checkout link older than this is assumed abandoned, so a fresh one is issued.
const CHECKOUT_REUSE_WINDOW_MS = 30 * 60 * 1000;

function authenticatedUserId(req) {
  return req.user?.id || req.user?._id;
}

function responsePlan(plan) {
  return { plan: serializePlan(plan) };
}

/** Only allow redirects back to an origin we own (no open redirect). */
function resolveRedirectUrl(requested) {
  const allowed = [process.env.FRONTEND_URL, process.env.TRAINING_URL]
    .filter(Boolean)
    .map(value => value.replace(/\/$/, ''));
  if (!requested) return allowed[0];
  try {
    const target = new URL(requested);
    const isAllowed = allowed.some(base => {
      try { return new URL(base).origin === target.origin; } catch { return false; }
    });
    return isAllowed ? requested : allowed[0];
  } catch {
    return allowed[0];
  }
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
  if (!user.isVerified) throw Object.assign(new Error('Please verify your email before paying'), { status: 403 });
  return user;
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

      const policy = resolveInstallmentPolicy(course);
      if (!policy.installmentsEnabled) return res.status(403).json({ message: 'This course does not offer installment plans' });
      if (course.enrollmentDeadline && new Date(course.enrollmentDeadline) < new Date()) {
        return res.status(409).json({ message: 'Enrollment for this course has closed' });
      }
      if (course.enrolledStudents.some(id => String(id) === String(userId))) return res.status(409).json({ message: 'Student is already enrolled in the course' });
      if (course.capacity && (course.enrolledStudents || []).length >= course.capacity) {
        return res.status(409).json({ message: 'This course is full' });
      }

      // A student who already paid in full must not be able to open a plan on top.
      const paidInFull = await Transaction.findOne({
        userId,
        courseId: course._id,
        type: { $in: ['course_payment', 'course_payment_wallet'] },
        status: 'successful',
      });
      if (paidInFull) return res.status(409).json({ message: 'You have already paid for this course' });

      let plan = await CoursePaymentPlan.findOne({ userId, courseId: course._id, status: { $in: ['pending', 'active', 'overdue'] } });
      if (!plan) {
        const totalAmountMinor = toMinorUnits(course.fee);
        if (!totalAmountMinor) return res.status(400).json({ message: 'This course does not require payment' });
        try {
          plan = await CoursePaymentPlan.create({
            userId,
            courseId: course._id,
            currency: 'NGN',
            installmentCount: policy.installmentCount,
            totalAmountMinor,
            priceSnapshot: { courseTitle: course.title, courseFee: Number(course.fee) },
            installments: buildInstallments(totalAmountMinor, policy.installmentCount),
          });
        } catch (createError) {
          // Lost a race against a concurrent create; the unique partial index held,
          // so adopt the plan that won instead of failing the request.
          if (createError?.code !== 11000) throw createError;
          plan = await CoursePaymentPlan.findOne({ userId, courseId: course._id, status: { $in: ['pending', 'active', 'overdue'] } });
          if (!plan) throw createError;
        }
      }

      return res.status(201).json({ ...responsePlan(plan), customer: { email: user.email, name: user.fullname, phone: user.phone || undefined } });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
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

  initializeInstallment: async (req, res) => {
    let transaction;
    let plan;
    const number = Number(req.params.number);
    try {
      plan = await getOwnedPlan(req, res);
      if (!plan) return;

      if (!Number.isInteger(number) || number < 1 || number > plan.installmentCount) {
        return res.status(400).json({ message: `Installment number must be between 1 and ${plan.installmentCount}` });
      }
      const user = await validateStudent(authenticatedUserId(req));

      if (plan.status === 'completed') return res.status(409).json({ message: 'This payment plan is already complete', plan: serializePlan(plan) });
      if (plan.status === 'cancelled') return res.status(409).json({ message: 'This payment plan has been cancelled' });

      const installment = plan.installments.find(item => item.number === number);
      if (!installment) return res.status(404).json({ message: 'Installment not found' });
      if (installment.status === 'paid') return res.status(409).json({ message: 'This installment has already been paid', plan: serializePlan(plan) });

      // Installments must be settled in order, otherwise a student could pay the
      // cheapest one and hold access while earlier ones stay outstanding.
      const previous = plan.installments.find(item => item.number === number - 1);
      if (previous && previous.status !== 'paid') return res.status(409).json({ message: 'Please pay the previous installment first' });

      // Reuse a recent, still-pending checkout rather than stacking charges.
      if (installment.txRef) {
        const existing = await Transaction.findOne({ txRef: installment.txRef, status: 'pending' });
        const isFresh = existing && (Date.now() - new Date(existing.date).getTime()) < CHECKOUT_REUSE_WINDOW_MS;
        if (isFresh && existing.metadata?.checkoutLink) {
          return res.status(200).json({ link: existing.metadata.checkoutLink, txRef: existing.txRef, plan: serializePlan(plan), reused: true });
        }
        // Stale attempt: retire it so the new reference is unambiguous.
        if (existing) await Transaction.updateOne({ _id: existing._id, status: 'pending' }, { $set: { status: 'failed' } });
      }

      const txRef = `course-plan-${plan._id}-${number}-${crypto.randomUUID()}`;
      transaction = await Transaction.create({
        userId: plan.userId,
        courseId: plan.courseId,
        paymentPlanId: plan._id,
        installmentNumber: number,
        amount: toMajorUnits(installment.amountMinor),
        txRef,
        type: 'course_installment',
        status: 'pending',
        currency: plan.currency,
        metadata: { title: plan.priceSnapshot.courseTitle, installmentNumber: number },
      });

      installment.txRef = txRef;
      installment.status = 'processing';
      installment.attempts += 1;
      installment.lastAttemptAt = new Date();
      await plan.save();

      const response = await axios.post(`${flutterwaveBaseURL}payments`, {
        tx_ref: txRef,
        amount: transaction.amount,
        currency: transaction.currency,
        redirect_url: resolveRedirectUrl(req.body.redirect_url),
        customer: { email: user.email, name: user.fullname, phonenumber: user.phone || undefined },
        customizations: { title: 'ExpertHub Training', description: `Installment ${number} of ${plan.installmentCount} for ${plan.priceSnapshot.courseTitle}` },
        meta: { userId: String(plan.userId), courseId: String(plan.courseId), paymentPlanId: String(plan._id), installmentNumber: number },
      }, { headers: flwHeaders, timeout: GATEWAY_TIMEOUT_MS });

      const link = response.data?.data?.link;
      if (response.data?.status !== 'success' || !link) throw new Error('Payment gateway did not return a checkout link');

      transaction.metadata = { ...(transaction.metadata || {}), checkoutLink: link };
      await transaction.save();
      return res.status(201).json({ link, txRef, plan: serializePlan(plan) });
    } catch (error) {
      if (transaction) {
        await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
        if (plan) {
          // Re-read before rolling back: the webhook may have already settled this
          // installment while the checkout call was failing on our side.
          const fresh = await CoursePaymentPlan.findById(plan._id);
          const freshInstallment = fresh?.installments.find(item => item.number === number);
          if (freshInstallment?.status === 'processing') {
            freshInstallment.status = 'failed';
            await fresh.save();
          }
        }
      }
      console.error('Installment initialization failed:', error.response?.data || error.message);
      if (error.status) return res.status(error.status).json({ message: error.message });
      return res.status(502).json({ message: 'Unable to start installment payment. Please try again.' });
    }
  },

  payInstallmentWithWallet: async (req, res) => {
    const number = Number(req.params.number);
    try {
      const plan = await getOwnedPlan(req, res);
      if (!plan) return;

      if (!Number.isInteger(number) || number < 1 || number > plan.installmentCount) {
        return res.status(400).json({ message: `Installment number must be between 1 and ${plan.installmentCount}` });
      }
      await validateStudent(authenticatedUserId(req));

      if (plan.status === 'cancelled') return res.status(409).json({ message: 'This payment plan has been cancelled' });

      const installment = plan.installments.find(item => item.number === number);
      const previous = plan.installments.find(item => item.number === number - 1);
      if (!installment || installment.status === 'paid') return res.status(409).json({ message: 'Installment is not payable' });
      if (previous && previous.status !== 'paid') return res.status(409).json({ message: 'Please pay the previous installment first' });

      const amount = toMajorUnits(installment.amountMinor);
      const user = await User.findOneAndUpdate(
        { _id: plan.userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true },
      );
      if (!user) return res.status(400).json({ message: 'Insufficient wallet balance' });

      const txRef = `course-plan-wallet-${plan._id}-${number}-${crypto.randomUUID()}`;
      const transaction = await Transaction.create({
        userId: plan.userId,
        courseId: plan.courseId,
        paymentPlanId: plan._id,
        installmentNumber: number,
        amount,
        txRef,
        type: 'course_installment_wallet',
        status: 'successful',
        currency: plan.currency,
        paidAt: new Date(),
      });

      try {
        await finalizeInstallmentPayment(transaction);
      } catch (error) {
        await User.findByIdAndUpdate(plan.userId, { $inc: { balance: amount } });
        await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
        throw error;
      }

      return res.json({ message: 'Installment paid successfully', plan: serializePlan(await CoursePaymentPlan.findById(plan._id)) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      console.error('Wallet installment payment failed:', error);
      return res.status(500).json({ message: 'Wallet payment failed. Please try again.' });
    }
  },
};

module.exports = paymentPlanController;
