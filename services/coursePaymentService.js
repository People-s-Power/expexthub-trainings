const crypto = require('crypto');
const axios = require('axios');
const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Transaction = require('../models/transactions.js');
const Notification = require('../models/notifications.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');

const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flwHeaders = { Authorization: `Bearer ${flutterwaveSecretKey}` };
const GATEWAY_TIMEOUT_MS = 20000;

const MINOR_UNIT = 100;
const PLATFORM_FEE_RATE = 0.05;
const GRACE_PERIOD_DAYS = 7;

// Part payments are chosen by the student, not scheduled by the tutor, so a plan
// is bounded by a settlement deadline instead of a fixed instalment calendar:
// the outstanding balance must be cleared within this many days of the first
// payment.
const SETTLEMENT_WINDOW_DAYS = 30;

// Floor on a single part payment, as a share of the course fee. Without it a
// student could unlock a course for a token amount and never return. The payment
// that clears the balance is exempt, so a small remainder is always payable.
const MIN_PART_PAYMENT_RATE = 0.2;

// Ceiling on how many separate charges one plan may accumulate. Each is a real
// gateway transaction with its own fee, so unbounded ₦1-over-minimum payments
// would cost more to collect than they are worth.
const MAX_PAYMENTS_PER_PLAN = 24;

// Transaction types that each, on their own, mean the course fee was settled in
// full. Anything checking "has this student already paid?" must consider all of
// them or it will let a paid student be charged twice.
const FULL_PAYMENT_TYPES = ['course_payment', 'course_payment_wallet'];

function toMinorUnits(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * MINOR_UNIT);
}

function toMajorUnits(amountMinor) {
  return Number((Number(amountMinor) / MINOR_UNIT).toFixed(2));
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * The smallest payment we will accept right now.
 *
 * Always capped at the outstanding balance so the final payment is never blocked
 * by the percentage floor — otherwise a student owing less than 20% of the fee
 * could not settle at all.
 */
function minimumPaymentMinor(totalAmountMinor, outstandingMinor) {
  const outstanding = Math.max(0, Number(outstandingMinor) || 0);
  if (outstanding <= 0) return 0;
  const floor = Math.ceil((Number(totalAmountMinor) || 0) * MIN_PART_PAYMENT_RATE);
  return Math.min(outstanding, Math.max(1, floor));
}

/**
 * Part payment is now a platform-level capability rather than a per-course
 * tutor setting: any course with a fee can be paid for in parts, and the student
 * decides each amount. Free courses have nothing to split.
 */
function resolvePartPaymentPolicy(course) {
  const totalAmountMinor = toMinorUnits(course?.fee);
  return {
    partPaymentEnabled: totalAmountMinor > 0,
    totalAmountMinor,
    minimumFirstPaymentMinor: minimumPaymentMinor(totalAmountMinor, totalAmountMinor),
    settlementWindowDays: SETTLEMENT_WINDOW_DAYS,
  };
}

function planOutstandingMinor(plan) {
  const total = Number(plan?.totalAmountMinor) || 0;
  const paid = Number(plan?.amountPaidMinor) || 0;
  return Math.max(0, total - paid);
}

/** The next free slot in the payment ledger. */
function nextPaymentNumber(plan) {
  const highest = (plan?.installments || []).reduce(
    (max, entry) => Math.max(max, Number(entry.number) || 0),
    0,
  );
  return highest + 1;
}

/**
 * Brings a stored plan in line with the part-payment model.
 *
 * Plans created under the old fixed-schedule design carry placeholder rows for
 * instalments that were never attempted. Those rows are meaningless once the
 * student picks their own amounts, so they are pruned — but anything that ever
 * reached the gateway (settled, in flight, or failed with a reference) is kept,
 * because a webhook may still arrive for it and it is matched by `number`.
 * Surviving rows are deliberately not renumbered, so those references stay valid.
 *
 * Returns true when the caller needs to persist the document.
 */
function normalizePlan(plan) {
  let changed = false;
  const entries = plan.installments || [];
  const settled = entries.filter(entry => entry.status === 'paid' || entry.status === 'processing' || Boolean(entry.txRef));

  if (settled.length !== entries.length) {
    plan.installments = settled;
    changed = true;
  }

  // Legacy plans predate these fields; derive them from the payment history so
  // the settlement clock starts from when the student actually first paid.
  const paidEntries = (plan.installments || []).filter(entry => entry.status === 'paid' && entry.paidAt);
  if (paidEntries.length) {
    const earliest = paidEntries.reduce((oldest, entry) => (entry.paidAt < oldest.paidAt ? entry : oldest));
    if (!plan.firstPaymentAt) {
      plan.firstPaymentAt = earliest.paidAt;
      changed = true;
    }
    if (!plan.settlementDueAt) {
      plan.settlementDueAt = addDays(plan.firstPaymentAt, SETTLEMENT_WINDOW_DAYS);
      changed = true;
    }
    if (!plan.lastPaymentAt) {
      const latest = paidEntries.reduce((newest, entry) => (entry.paidAt > newest.paidAt ? entry : newest));
      plan.lastPaymentAt = latest.paidAt;
      changed = true;
    }
  }

  return changed;
}

/**
 * Recomputes derived plan state from the clock: flags an unsettled balance
 * overdue past its deadline, and suspends course access once the grace period
 * has also elapsed. Returns true when the caller needs to persist the document.
 */
function refreshDueStatus(plan) {
  const now = new Date();
  let changed = normalizePlan(plan);

  const total = Number(plan.totalAmountMinor) || 0;
  const paid = Number(plan.amountPaidMinor) || 0;

  if (total > 0 && paid >= total) {
    if (plan.status !== 'completed') { plan.status = 'completed'; changed = true; }
    if (plan.accessStatus !== 'active') { plan.accessStatus = 'active'; changed = true; }
    return changed;
  }

  if (plan.status === 'cancelled') return changed;

  // Nothing paid yet — the plan is a quote, not a debt, so no clock runs on it.
  if (paid <= 0) {
    if (plan.status !== 'pending') { plan.status = 'pending'; changed = true; }
    return changed;
  }

  const dueAt = plan.settlementDueAt ? new Date(plan.settlementDueAt) : null;
  if (!dueAt || now <= dueAt) {
    if (plan.status !== 'active') { plan.status = 'active'; changed = true; }
    return changed;
  }

  if (plan.status !== 'overdue') { plan.status = 'overdue'; changed = true; }

  // The grace period runs from the later of the deadline and the last payment, so
  // a student who is still actively paying down the balance keeps their access
  // even after the original deadline passes.
  const lastPaymentAt = plan.lastPaymentAt ? new Date(plan.lastPaymentAt) : dueAt;
  const graceStartsAt = lastPaymentAt > dueAt ? lastPaymentAt : dueAt;
  if (now > addDays(graceStartsAt, GRACE_PERIOD_DAYS) && plan.accessStatus === 'active') {
    plan.accessStatus = 'suspended';
    changed = true;
  }

  return changed;
}

function serializePlan(plan) {
  const data = plan.toObject ? plan.toObject() : plan;
  const totalMinor = Number(data.totalAmountMinor) || 0;
  const paidMinor = Number(data.amountPaidMinor) || 0;
  const outstandingMinor = Math.max(0, totalMinor - paidMinor);

  // Only settled and in-flight payments are shown; the ledger has no future rows
  // to display because the student has not committed to them yet.
  const payments = (data.installments || [])
    .map(entry => ({ ...entry, amount: toMajorUnits(entry.amountMinor) }))
    .sort((a, b) => a.number - b.number);

  const pendingPayment = payments.find(entry => entry.status === 'processing') || null;
  const inFlightMinor = payments
    .filter(entry => entry.status === 'processing')
    .reduce((sum, entry) => sum + (Number(entry.amountMinor) || 0), 0);
  const availableMinor = Math.max(0, outstandingMinor - inFlightMinor);

  return {
    ...data,
    totalAmount: toMajorUnits(totalMinor),
    amountPaid: toMajorUnits(paidMinor),
    amountOutstanding: toMajorUnits(outstandingMinor),
    amountInProgress: toMajorUnits(inFlightMinor),
    // Everything the client needs to render and validate the amount field without
    // re-deriving policy of its own.
    minimumNextPayment: toMajorUnits(minimumPaymentMinor(totalMinor, availableMinor)),
    maximumNextPayment: toMajorUnits(availableMinor),
    paymentsMade: payments.filter(entry => entry.status === 'paid').length,
    paymentsRemaining: Math.max(0, MAX_PAYMENTS_PER_PLAN - payments.filter(entry => entry.status !== 'failed').length),
    payments,
    // Retained under the old key so any client still reading `installments`
    // during the rollout keeps working.
    installments: payments,
    pendingPaymentNumber: pendingPayment ? pendingPayment.number : null,
    isComplete: data.status === 'completed',
    hasCourseAccess: data.accessStatus === 'active',
  };
}

/** Money already committed to a checkout that has not resolved yet. */
function planInFlightMinor(plan) {
  return (plan?.installments || [])
    .filter(entry => entry.status === 'processing')
    .reduce((sum, entry) => sum + (Number(entry.amountMinor) || 0), 0);
}

/**
 * Validates a student-chosen payment amount against the plan.
 *
 * Returns { amountMinor } on success, or { error } with a message the client can
 * show verbatim.
 */
function validatePaymentAmount(plan, requestedAmount) {
  const outstandingMinor = planOutstandingMinor(plan);
  if (outstandingMinor <= 0) return { error: 'This course is already fully paid' };

  // Abandoned attempts are retained for audit but must not consume the student's
  // budget of real payments.
  const chargeable = (plan.installments || []).filter(entry => entry.status !== 'failed');
  if (chargeable.length >= MAX_PAYMENTS_PER_PLAN) {
    return { error: 'You have reached the maximum number of part payments for this course. Please pay the remaining balance in one payment.' };
  }

  // A checkout that is still open has already claimed part of the balance;
  // ignoring it would let a student open two tabs and overpay the course.
  const availableMinor = outstandingMinor - planInFlightMinor(plan);
  if (availableMinor <= 0) {
    return { error: 'You already have a payment in progress for this course. Complete or cancel it before starting another.' };
  }

  const value = Number(requestedAmount);
  if (!Number.isFinite(value) || value <= 0) return { error: 'Enter the amount you want to pay' };

  const amountMinor = toMinorUnits(value);
  const minimumMinor = minimumPaymentMinor(Number(plan.totalAmountMinor) || 0, availableMinor);

  if (amountMinor > availableMinor) {
    return { error: `The most you can pay right now is ${toMajorUnits(availableMinor)}` };
  }
  if (amountMinor < minimumMinor) {
    return { error: `The minimum payment is ${toMajorUnits(minimumMinor)}` };
  }

  return { amountMinor };
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

/**
 * Settles one part payment against its plan.
 *
 * Named for the transaction type it serves (`course_installment`), which is kept
 * stable so payments already in flight at the gateway when this shipped still
 * finalize through the webhook.
 */
async function finalizeInstallmentPayment(transaction, gatewayPayment) {
  const plan = await CoursePaymentPlan.findById(transaction.paymentPlanId);
  if (!plan) throw new Error('Payment plan not found');

  const paymentNumber = Number(transaction.installmentNumber);
  const payment = plan.installments.find(item => item.number === paymentNumber);
  if (!payment) throw new Error('Payment not found on plan');

  const transactionUpdate = {
    status: 'successful',
    paidAt: transaction.paidAt || new Date(),
  };
  if (gatewayPayment?.id) transactionUpdate.gatewayTransactionId = String(gatewayPayment.id);
  await Transaction.updateOne({ _id: transaction._id, status: { $ne: 'successful' } }, { $set: transactionUpdate });

  const now = new Date();
  // The settlement clock starts at the first payment and is never extended by
  // later ones, so a plan cannot be strung out indefinitely by paying the
  // minimum whenever the deadline approaches.
  const settlementDueAt = plan.settlementDueAt || addDays(now, SETTLEMENT_WINDOW_DAYS);

  // The elemMatch guard is what makes the $inc safe: only the first finalizer
  // to flip this payment to paid also increments the paid total, so a replayed
  // webhook cannot inflate amountPaidMinor.
  const updatedPlan = await CoursePaymentPlan.findOneAndUpdate(
    { _id: plan._id, installments: { $elemMatch: { number: paymentNumber, status: { $ne: 'paid' } } } },
    {
      $set: {
        'installments.$.status': 'paid',
        'installments.$.gatewayTransactionId': gatewayPayment?.id ? String(gatewayPayment.id) : payment.gatewayTransactionId,
        'installments.$.paidAt': now,
        status: 'active',
        accessStatus: 'active',
        lastPaymentAt: now,
        firstPaymentAt: plan.firstPaymentAt || now,
        settlementDueAt,
      },
      $inc: { amountPaidMinor: payment.amountMinor },
    },
    { new: true },
  );

  const currentPlan = updatedPlan || await CoursePaymentPlan.findById(plan._id);
  const isSettled = Number(currentPlan.amountPaidMinor) >= Number(currentPlan.totalAmountMinor);
  if (isSettled && currentPlan.status !== 'completed') {
    currentPlan.status = 'completed';
    currentPlan.accessStatus = 'active';
    await currentPlan.save();
  }

  // Access is granted from the first settled payment onward.
  await grantCourseAccess({ userId: currentPlan.userId, courseId: currentPlan.courseId, plan: currentPlan });

  // Only credit when this call is the one that actually marked the payment paid;
  // otherwise a replay would pay the instructor twice for one payment.
  if (updatedPlan) {
    await creditInstructor(transaction, Number(transaction.amount));
  }

  return currentPlan;
}

/** Only allow redirect targets we own, so the checkout cannot be turned into an
 * open redirect that hands a payment reference to somebody else's page. */
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

/**
 * Opens a hosted Flutterwave checkout and returns its link.
 *
 * Bank transfer is listed first because a tutor enrolling a student needs an
 * account number to hand over — the hosted page renders one for the exact
 * amount, so no money is ever collected as cash. Card and USSD stay available
 * for a student paying for themselves.
 *
 * Every caller shares this one definition so the payload, timeout and failure
 * semantics cannot drift between the student and tutor entry points.
 */
async function initializeGatewayCheckout({ txRef, amount, currency = 'NGN', customer, title, description, meta, redirectUrl }) {
  const response = await axios.post(`${flutterwaveBaseURL}payments`, {
    tx_ref: txRef,
    amount,
    currency,
    redirect_url: resolveRedirectUrl(redirectUrl),
    payment_options: 'banktransfer,card,ussd',
    customer: {
      email: customer?.email,
      name: customer?.name,
      phonenumber: customer?.phone || undefined,
    },
    customizations: { title: title || 'ExpertHub Training', description },
    meta,
  }, { headers: flwHeaders, timeout: GATEWAY_TIMEOUT_MS });

  const link = response.data?.data?.link;
  if (response.data?.status !== 'success' || !link) {
    throw new Error('Payment gateway did not return a checkout link');
  }
  return link;
}

/**
 * Opens or reuses the live part-payment plan for a student on a course.
 *
 * Shared by the student-facing endpoint and by the tutor-initiated enrolment
 * flow so both go through exactly one definition of "the student's live plan".
 */
async function openPlanForStudent({ user, course, createdBy }) {
  const policy = resolvePartPaymentPolicy(course);
  if (!policy.partPaymentEnabled) {
    throw Object.assign(new Error('This course does not require payment'), { status: 400 });
  }

  const existing = await CoursePaymentPlan.findOne({
    userId: user._id,
    courseId: course._id,
    status: { $in: ['pending', 'active', 'overdue'] },
  });
  if (existing) {
    if (refreshDueStatus(existing)) await existing.save();
    return existing;
  }

  try {
    return await CoursePaymentPlan.create({
      userId: user._id,
      courseId: course._id,
      currency: 'NGN',
      totalAmountMinor: policy.totalAmountMinor,
      priceSnapshot: { courseTitle: course.title, courseFee: Number(course.fee) },
      installments: [],
      createdBy: createdBy || undefined,
    });
  } catch (createError) {
    // Lost a race against a concurrent create; the unique partial index held, so
    // adopt the plan that won instead of failing the request.
    if (createError?.code !== 11000) throw createError;
    const winner = await CoursePaymentPlan.findOne({
      userId: user._id,
      courseId: course._id,
      status: { $in: ['pending', 'active', 'overdue'] },
    });
    if (!winner) throw createError;
    return winner;
  }
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
  FULL_PAYMENT_TYPES,
  PLATFORM_FEE_RATE,
  GRACE_PERIOD_DAYS,
  SETTLEMENT_WINDOW_DAYS,
  MIN_PART_PAYMENT_RATE,
  MAX_PAYMENTS_PER_PLAN,
  toMinorUnits,
  toMajorUnits,
  addDays,
  serializePlan,
  normalizePlan,
  refreshDueStatus,
  resolvePartPaymentPolicy,
  planOutstandingMinor,
  planInFlightMinor,
  nextPaymentNumber,
  minimumPaymentMinor,
  validatePaymentAmount,
  openPlanForStudent,
  grantCourseAccess,
  creditInstructor,
  finalizeFullCoursePayment,
  finalizeInstallmentPayment,
  hasActiveCourseAccess,
  resolveRedirectUrl,
  initializeGatewayCheckout,
};
