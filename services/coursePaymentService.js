const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Transaction = require('../models/transactions.js');
const Notification = require('../models/notifications.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');

const MINOR_UNIT = 100;

function toMinorUnits(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * MINOR_UNIT);
}

function toMajorUnits(amountMinor) {
  return Number((Number(amountMinor) / MINOR_UNIT).toFixed(2));
}

function serializePlan(plan) {
  const data = plan.toObject ? plan.toObject() : plan;
  return {
    ...data,
    totalAmount: toMajorUnits(data.totalAmountMinor),
    amountPaid: toMajorUnits(data.amountPaidMinor),
    amountOutstanding: toMajorUnits(data.totalAmountMinor - data.amountPaidMinor),
    installments: (data.installments || []).map(installment => ({
      ...installment,
      amount: toMajorUnits(installment.amountMinor),
    })),
  };
}

function buildInstallments(totalAmountMinor, now = new Date()) {
  const first = Math.floor(totalAmountMinor / 3);
  const second = Math.floor(totalAmountMinor / 3);
  const amounts = [first, second, totalAmountMinor - first - second];
  return amounts.map((amountMinor, index) => {
    const dueAt = new Date(now);
    dueAt.setUTCDate(dueAt.getUTCDate() + (index * 30));
    return { number: index + 1, amountMinor, dueAt, status: 'pending' };
  });
}

function refreshDueStatus(plan) {
  const now = new Date();
  let changed = false;
  for (const installment of plan.installments || []) {
    if (installment.status === 'pending' && installment.number > 1 && installment.dueAt < now) {
      installment.status = 'overdue';
      changed = true;
    }
  }
  if (changed && plan.status !== 'completed') plan.status = 'overdue';
  return changed;
}

async function grantCourseAccess({ userId, courseId, plan }) {
  const [course, user] = await Promise.all([Course.findById(courseId), User.findById(userId)]);
  if (!course || !user) throw new Error('Course or student not found');

  const alreadyEnrolled = (course.enrolledStudents || []).some(id => String(id) === String(userId));
  if (alreadyEnrolled) return false;

  const enrollmentStatus = plan ? 'payment_plan_active' : 'active';
  course.enrolledStudents.addToSet(user._id);
  course.enrollments.push({
    user: user._id,
    status: enrollmentStatus,
    enrolledOn: new Date().toISOString(),
  });
  await course.save();

  user.contact = false;
  await user.save();

  await Notification.create({
    title: 'Course enrolled',
    content: `${user.fullname} Just enrolled for your Course ${course.title}`,
    contentId: course._id,
    userId: course.instructorId,
  });
  return true;
}

async function creditInstructor(transaction, amountMajor) {
  const course = await Course.findById(transaction.courseId).select('instructorId');
  if (!course?.instructorId || amountMajor <= 0) return;

  const creditRef = `course-credit-${transaction.txRef}`;
  try {
    await Transaction.create({
      userId: course.instructorId,
      courseId: transaction.courseId,
      amount: amountMajor,
      type: 'credit',
      status: 'successful',
      txRef: creditRef,
      metadata: { sourceTransaction: transaction.txRef },
    });
  } catch (error) {
    if (error?.code === 11000) return; // Already credited; webhook/redirect replay.
    throw error;
  }

  await User.findByIdAndUpdate(course.instructorId, { $inc: { balance: amountMajor * 0.95 } });
}

async function finalizeFullCoursePayment(transaction, gatewayPayment) {
  const update = {
    status: 'successful',
    gatewayTransactionId: gatewayPayment?.id ? String(gatewayPayment.id) : transaction.gatewayTransactionId,
  };
  await Transaction.updateOne({ _id: transaction._id, status: { $ne: 'successful' } }, { $set: update });
  const current = await Transaction.findById(transaction._id);
  await grantCourseAccess({ userId: current.userId, courseId: current.courseId });
  await creditInstructor(current, Number(current.amount));
  return current;
}

async function finalizeInstallmentPayment(transaction, gatewayPayment) {
  const plan = await CoursePaymentPlan.findById(transaction.paymentPlanId);
  if (!plan) throw new Error('Payment plan not found');
  const installmentNumber = Number(transaction.installmentNumber);
  const installment = plan.installments.find(item => item.number === installmentNumber);
  if (!installment) throw new Error('Installment not found');

  await Transaction.updateOne({ _id: transaction._id, status: { $ne: 'successful' } }, {
    $set: {
      status: 'successful',
      gatewayTransactionId: gatewayPayment?.id ? String(gatewayPayment.id) : transaction.gatewayTransactionId,
    },
  });

  const updatedPlan = await CoursePaymentPlan.findOneAndUpdate(
    { _id: plan._id, installments: { $elemMatch: { number: installmentNumber, status: { $ne: 'paid' } } } },
    {
      $set: {
        'installments.$.status': 'paid',
        'installments.$.gatewayTransactionId': gatewayPayment?.id ? String(gatewayPayment.id) : installment.gatewayTransactionId,
        'installments.$.paidAt': new Date(),
        status: 'active',
        accessStatus: 'active',
        lastPaymentAt: new Date(),
      },
      $inc: { amountPaidMinor: installment.amountMinor },
    },
    { new: true },
  );
  const currentPlan = updatedPlan || await CoursePaymentPlan.findById(plan._id);
  const allPaid = currentPlan.installments.every(item => item.status === 'paid');
  if (allPaid && currentPlan.status !== 'completed') {
    currentPlan.status = 'completed';
    currentPlan.accessStatus = 'active';
    await currentPlan.save();
  }

  await grantCourseAccess({ userId: currentPlan.userId, courseId: currentPlan.courseId, plan: currentPlan });
  await creditInstructor(transaction, Number(transaction.amount));
  return currentPlan;
}

module.exports = {
  MINOR_UNIT,
  toMinorUnits,
  toMajorUnits,
  serializePlan,
  buildInstallments,
  refreshDueStatus,
  grantCourseAccess,
  creditInstructor,
  finalizeFullCoursePayment,
  finalizeInstallmentPayment,
};
