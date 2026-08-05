const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Transaction = require('../models/transactions.js');
const Notification = require('../models/notifications.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');

const MINOR_UNIT = 100;
const PLATFORM_FEE_RATE = 0.05;
const INSTALLMENT_INTERVAL_DAYS = 30;
const GRACE_PERIOD_DAYS = 7;

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
  const totalMinor = Number(data.totalAmountMinor) || 0;
  const paidMinor = Number(data.amountPaidMinor) || 0;
  const installments = (data.installments || []).map(installment => ({
    ...installment,
    amount: toMajorUnits(installment.amountMinor),
  }));
  const nextDue = installments.find(installment => installment.status !== 'paid') || null;

  return {
    ...data,
    totalAmount: toMajorUnits(totalMinor),
    amountPaid: toMajorUnits(paidMinor),
    amountOutstanding: toMajorUnits(Math.max(0, totalMinor - paidMinor)),
    installments,
    // Surfaced so the client never has to re-derive payment sequencing itself.
    nextInstallmentNumber: nextDue ? nextDue.number : null,
    isComplete: data.status === 'completed',
    hasCourseAccess: data.accessStatus === 'active',
  };
}

function buildInstallments(totalAmountMinor, now = new Date()) {
  const first = Math.floor(totalAmountMinor / 3);
  const second = Math.floor(totalAmountMinor / 3);
  // The remainder lands on the final installment so the three always sum to the
  // exact total — no lost or invented kobo.
  const amounts = [first, second, totalAmountMinor - first - second];
  return amounts.map((amountMinor, index) => {
    const dueAt = new Date(now);
    dueAt.setUTCDate(dueAt.getUTCDate() + (index * INSTALLMENT_INTERVAL_DAYS));
    return { number: index + 1, amountMinor, dueAt, status: 'pending' };
  });
}

/**
 * Recomputes derived plan state from the clock: marks passed installments
 * overdue and suspends course access once an installment is overdue beyond the
 * grace period. Returns true when the caller needs to persist the document.
 */
function refreshDueStatus(plan) {
  const now = new Date();
  let changed = false;

  for (const installment of plan.installments || []) {
    // Installment 1 is due immediately at checkout, so it is never "overdue" —
    // access simply is not granted until it is paid.
    if (installment.status === 'pending' && installment.number > 1 && installment.dueAt < now) {
      installment.status = 'overdue';
      changed = true;
    }
  }

  const overdue = (plan.installments || []).filter(installment => installment.status === 'overdue');
  const allPaid = (plan.installments || []).length > 0 && (plan.installments || []).every(item => item.status === 'paid');

  if (allPaid) {
    if (plan.status !== 'completed') { plan.status = 'completed'; changed = true; }
    if (plan.accessStatus !== 'active') { plan.accessStatus = 'active'; changed = true; }
    return changed;
  }

  if (overdue.length && plan.status !== 'cancelled') {
    if (plan.status !== 'overdue') { plan.status = 'overdue'; changed = true; }

    // Students keep access through a grace period so a late payment does not
    // instantly lock them out of a course they have partly paid for.
    const worstOverdue = overdue.reduce((oldest, item) => (item.dueAt < oldest.dueAt ? item : oldest));
    const graceExpiresAt = new Date(worstOverdue.dueAt);
    graceExpiresAt.setUTCDate(graceExpiresAt.getUTCDate() + GRACE_PERIOD_DAYS);

    const shouldSuspend = now > graceExpiresAt;
    if (shouldSuspend && plan.accessStatus === 'active') {
      plan.accessStatus = 'suspended';
      changed = true;
    }
  }

  return changed;
}

/**
 * Grants course access exactly once, atomically.
 *
 * The redirect verification and the webhook routinely race for the same
 * payment. A read-then-write here would let both observe "not enrolled" and
 * push two enrollment rows. The conditional update makes the winner decidable
 * by the database: only the request whose filter still matches performs the
 * write, and it reports whether it was the one that did.
 */
async function grantCourseAccess({ userId, courseId, plan, session }) {
  const options = session ? { session } : {};
  const [course, user] = await Promise.all([
    Course.findById(courseId).setOptions(options),
    User.findById(userId).setOptions(options),
  ]);
  if (!course || !user) throw new Error('Course or student not found');

  const enrollmentStatus = plan ? 'payment_plan_active' : 'active';
  const result = await Course.updateOne(
    { _id: course._id, enrolledStudents: { $ne: user._id } },
    {
      $addToSet: { enrolledStudents: user._id },
      $push: {
        enrollments: {
          user: user._id,
          status: enrollmentStatus,
          enrolledOn: new Date(),
        },
      },
    },
    options,
  );

  if (result.modifiedCount === 0) {
    // Already enrolled — another concurrent finalizer won the race, or this is
    // a replayed webhook. Nothing further to do.
    return false;
  }

  await User.updateOne({ _id: user._id }, { $set: { contact: false } }, options);

  // Notification failure must not roll back a paid enrollment.
  try {
    await Notification.create({
      title: 'Course enrolled',
      content: `${user.fullname} just enrolled for your course ${course.title}`,
      contentId: course._id,
      userId: course.instructorId,
    });
  } catch (error) {
    console.error('Enrollment notification failed:', error.message);
  }

  return true;
}

/**
 * Credits the instructor their net share exactly once per source payment.
 *
 * Idempotency is enforced by the unique txRef derived from the originating
 * transaction: a replayed webhook hits the duplicate-key error and returns
 * without touching the balance.
 */
async function creditInstructor(transaction, amountMajor) {
  const course = await Course.findById(transaction.courseId).select('instructorId');
  if (!course?.instructorId || !(amountMajor > 0)) return false;

  const netAmount = Number((amountMajor * (1 - PLATFORM_FEE_RATE)).toFixed(2));
  const creditRef = `course-credit-${transaction.txRef}`;

  try {
    // The ledger row records the net amount actually credited, so the sum of an
    // instructor's credit transactions reconciles against their balance.
    await Transaction.create({
      userId: course.instructorId,
      courseId: transaction.courseId,
      amount: netAmount,
      type: 'credit',
      status: 'successful',
      txRef: creditRef,
      metadata: {
        sourceTransaction: transaction.txRef,
        grossAmount: amountMajor,
        platformFee: Number((amountMajor * PLATFORM_FEE_RATE).toFixed(2)),
      },
    });
  } catch (error) {
    if (error?.code === 11000) return false; // Already credited; webhook/redirect replay.
    throw error;
  }

  await User.findByIdAndUpdate(course.instructorId, { $inc: { balance: netAmount } });
  return true;
}

async function finalizeFullCoursePayment(transaction, gatewayPayment) {
  const update = {
    status: 'successful',
    paidAt: transaction.paidAt || new Date(),
  };
  if (gatewayPayment?.id) update.gatewayTransactionId = String(gatewayPayment.id);

  await Transaction.updateOne({ _id: transaction._id, status: { $ne: 'successful' } }, { $set: update });

  const current = await Transaction.findById(transaction._id);
  if (!current) throw new Error('Transaction disappeared during finalization');

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

  const transactionUpdate = {
    status: 'successful',
    paidAt: transaction.paidAt || new Date(),
  };
  if (gatewayPayment?.id) transactionUpdate.gatewayTransactionId = String(gatewayPayment.id);
  await Transaction.updateOne({ _id: transaction._id, status: { $ne: 'successful' } }, { $set: transactionUpdate });

  // The elemMatch guard is what makes the $inc safe: only the first finalizer
  // to flip this installment to paid also increments the paid total, so a
  // replayed webhook cannot inflate amountPaidMinor.
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

  // Access is granted from the first paid installment onward.
  await grantCourseAccess({ userId: currentPlan.userId, courseId: currentPlan.courseId, plan: currentPlan });

  // Only credit when this call is the one that actually marked the installment
  // paid; otherwise a replay would pay the instructor twice for one installment.
  if (updatedPlan) {
    await creditInstructor(transaction, Number(transaction.amount));
  }

  return currentPlan;
}

/** True when the student may open course content right now. */
async function hasActiveCourseAccess(userId, courseId) {
  const course = await Course.findById(courseId).select('enrolledStudents fee').lean();
  if (!course) return false;

  const isEnrolled = (course.enrolledStudents || []).some(id => String(id) === String(userId));
  if (!isEnrolled) return false;
  if (!(Number(course.fee) > 0)) return true;

  const plan = await CoursePaymentPlan.findOne({ userId, courseId, status: { $ne: 'cancelled' } });
  if (!plan) return true; // Paid in full, or enrolled by scholarship.

  if (refreshDueStatus(plan)) await plan.save();
  return plan.accessStatus === 'active';
}

module.exports = {
  MINOR_UNIT,
  PLATFORM_FEE_RATE,
  GRACE_PERIOD_DAYS,
  toMinorUnits,
  toMajorUnits,
  serializePlan,
  buildInstallments,
  refreshDueStatus,
  grantCourseAccess,
  creditInstructor,
  finalizeFullCoursePayment,
  finalizeInstallmentPayment,
  hasActiveCourseAccess,
};
