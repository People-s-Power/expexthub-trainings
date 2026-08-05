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
} = require('../services/coursePaymentService.js');

const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';
const flwHeaders = { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET}` };

function authenticatedUserId(req) {
  return req.user?.id || req.user?._id;
}

function responsePlan(plan) {
  return { plan: serializePlan(plan) };
}

async function getOwnedPlan(req, res) {
  const userId = authenticatedUserId(req);
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
      if (course.enrolledStudents.some(id => String(id) === String(userId))) return res.status(409).json({ message: 'Student is already enrolled in the course' });

      let plan = await CoursePaymentPlan.findOne({ userId, courseId: course._id, status: { $in: ['pending', 'active', 'overdue'] } });
      if (!plan) {
        const totalAmountMinor = toMinorUnits(course.fee);
        if (!totalAmountMinor) return res.status(400).json({ message: 'This course does not require payment' });
        plan = await CoursePaymentPlan.create({
          userId,
          courseId: course._id,
          currency: 'NGN',
          totalAmountMinor,
          priceSnapshot: { courseTitle: course.title, courseFee: Number(course.fee) },
          installments: buildInstallments(totalAmountMinor),
        });
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
    try {
      plan = await getOwnedPlan(req, res);
      if (!plan) return;
      const user = await validateStudent(authenticatedUserId(req));
      const number = Number(req.params.number);
      if (![1, 2, 3].includes(number)) return res.status(400).json({ message: 'Installment number must be 1, 2, or 3' });
      const installment = plan.installments.find(item => item.number === number);
      if (!installment) return res.status(404).json({ message: 'Installment not found' });
      if (installment.status === 'paid') return res.status(409).json({ message: 'This installment has already been paid', plan: serializePlan(plan) });
      const previous = plan.installments.find(item => item.number === number - 1);
      if (previous && previous.status !== 'paid') return res.status(409).json({ message: 'Please pay the previous installment first' });

      if (installment.txRef) {
        const existing = await Transaction.findOne({ txRef: installment.txRef, status: 'pending' });
        if (existing?.metadata?.checkoutLink) return res.status(200).json({ link: existing.metadata.checkoutLink, txRef: existing.txRef, plan: serializePlan(plan) });
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

      const redirectUrl = req.body.redirect_url || process.env.FRONTEND_URL;
      if (!redirectUrl) throw new Error('Payment redirect URL is not configured');
      const response = await axios.post(`${flutterwaveBaseURL}payments`, {
        tx_ref: txRef,
        amount: transaction.amount,
        currency: transaction.currency,
        redirect_url: redirectUrl,
        customer: { email: user.email, name: user.fullname, phonenumber: user.phone || undefined },
        customizations: { title: 'ExpertHub Training', description: `Installment ${number} of 3 for ${plan.priceSnapshot.courseTitle}` },
        meta: { userId: String(plan.userId), courseId: String(plan.courseId), paymentPlanId: String(plan._id), installmentNumber: number },
      }, { headers: flwHeaders });
      const link = response.data?.data?.link;
      if (response.data?.status !== 'success' || !link) throw new Error('Payment gateway did not return a checkout link');
      transaction.metadata = { ...(transaction.metadata || {}), checkoutLink: link };
      await transaction.save();
      return res.status(201).json({ link, txRef, plan: serializePlan(plan) });
    } catch (error) {
      if (transaction) {
        await Transaction.updateOne({ _id: transaction._id, status: 'pending' }, { $set: { status: 'failed' } });
        if (plan) {
          const installment = plan.installments.find(item => item.number === Number(req.params.number));
          if (installment?.status === 'processing') {
            installment.status = 'failed';
            await plan.save();
          }
        }
      }
      console.error('Installment initialization failed:', error.response?.data || error.message);
      return res.status(error.status || 502).json({ message: 'Unable to start installment payment. Please try again.' });
    }
  },

  payInstallmentWithWallet: async (req, res) => {
    try {
      const plan = await getOwnedPlan(req, res);
      if (!plan) return;
      const number = Number(req.params.number);
      const installment = plan.installments.find(item => item.number === number);
      const previous = plan.installments.find(item => item.number === number - 1);
      if (!installment || installment.status === 'paid') return res.status(409).json({ message: 'Installment is not payable' });
      if (previous && previous.status !== 'paid') return res.status(409).json({ message: 'Please pay the previous installment first' });
      const amount = toMajorUnits(installment.amountMinor);
      const user = await User.findOneAndUpdate({ _id: plan.userId, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
      if (!user) return res.status(400).json({ message: 'Insufficient wallet balance' });
      const txRef = `course-plan-wallet-${plan._id}-${number}-${crypto.randomUUID()}`;
      const transaction = await Transaction.create({ userId: plan.userId, courseId: plan.courseId, paymentPlanId: plan._id, installmentNumber: number, amount, txRef, type: 'course_installment_wallet', status: 'successful', currency: plan.currency });
      try {
        await finalizeInstallmentPayment(transaction);
      } catch (error) {
        await User.findByIdAndUpdate(plan.userId, { $inc: { balance: amount } });
        await Transaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } });
        throw error;
      }
      return res.json({ message: 'Installment paid successfully', plan: serializePlan(await CoursePaymentPlan.findById(plan._id)) });
    } catch (error) {
      console.error('Wallet installment payment failed:', error);
      return res.status(500).json({ message: 'Wallet payment failed. Please try again.' });
    }
  },
};

module.exports = paymentPlanController;
