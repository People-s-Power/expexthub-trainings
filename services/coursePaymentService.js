const crypto = require('crypto');
const axios = require('axios');
const Course = require('../models/courses.js');
const User = require('../models/user.js');
const Transaction = require('../models/transactions.js');
const Notification = require('../models/notifications.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const { sendPaymentReceiptOnce } = require('../utils/emails/receiptDispatcher.js');
const { generateCommissionForPayment } = require('./affiliateCommissionService.js');
const {
  MINOR_UNIT,
  MAX_SHARE_PERCENT,
  clampPercentage,
  percentageOf,
  roundMoney,
} = require('../utils/revenueShare.js');

const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flwHeaders = { Authorization: `Bearer ${flutterwaveSecretKey}` };
const GATEWAY_TIMEOUT_MS = 20000;

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

// A hosted checkout left unpaid for longer than this is treated as abandoned, so
// its slot is released and a fresh charge can start. Kept deliberately generous:
// within the window the payment may still be completing (a bank transfer clears
// out of band), so blocking is the correct, no-double-charge answer; only past it
// do we assume the tutor or student walked away. Shared by every entry point that
// opens a part payment so the definition of "abandoned" cannot drift between them.
const CHECKOUT_REUSE_WINDOW_MS = 30 * 60 * 1000;

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
 * Whether this course may be paid for in parts, and on what terms.
 *
 * Two independent conditions, both required. The instructor must have consented
 * (`course.partPaymentEnabled`) — part payment defers their earnings, so it is
 * theirs to offer rather than the platform's to impose. And the course must
 * actually cost something, since a free course has nothing to split.
 *
 * This is the single source of truth for the policy. Do not re-derive it inline:
 * a second copy is how the checkout and the course page drift apart.
 *
 * Note what this does NOT govern — settling a plan that already exists. An
 * instructor who switches the toggle off stops being offered to new students;
 * a student already part-way through keeps paying down their balance on the
 * terms they accepted. See `openPlanForStudent`.
 */
function resolvePartPaymentPolicy(course) {
  const totalAmountMinor = toMinorUnits(course?.fee);
  return {
    partPaymentEnabled: totalAmountMinor > 0 && course?.partPaymentEnabled === true,
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

/**
 * What one enrollment was expected to pay, what landed, and what is left.
 *
 * The single implementation of the owed calculation. The admissions payment
 * table reads it off an aggregate row and the graduation gate reads it off
 * documents; both have to answer the same question the same way, or a provider
 * is refused graduation for a student whose row on screen shows as settled.
 *
 * `expected` is the plan's snapshot when there is one — the fee the student
 * actually agreed to, so a later fee edit cannot change a balance they are
 * being held to — and the course fee otherwise. A scholarship place expects
 * nothing by definition, which is what keeps waived seats out of the owed
 * column.
 *
 * Amounts are major units (naira) except the plan's own `*Minor` fields, which
 * are kobo; mixing the two is what makes a balance look 100× wrong.
 */
function summarizeEnrollmentPaid({
  scholarship = false,
  planTotalMinor = 0,
  planPaidMinor = 0,
  fullPaidMajor = 0,
  feeMajor = 0,
} = {}) {
  if (scholarship) return { expected: 0, paid: 0, owed: 0, settled: true };

  const expected = Number(planTotalMinor) > 0
    ? Number(planTotalMinor) / MINOR_UNIT
    : Number(feeMajor) || 0;
  const paid = Number((Number(fullPaidMajor) + Number(planPaidMinor) / MINOR_UNIT).toFixed(2));
  const owed = Number(Math.max(0, expected - paid).toFixed(2));

  return { expected, paid, owed, settled: owed <= 0 };
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
 * Releases checkout slots that were opened but never completed.
 *
 * A `processing` installment holds part of the balance and blocks a fresh charge.
 * That is correct while a payment might still be completing, but a checkout the
 * payer walked away from would otherwise pin the slot forever — an abandoned
 * tutor checkout was locking students out of re-enrollment (see the stale-checkout
 * lockout fix). So any `processing` installment older than the reuse window is
 * flipped to `failed`, along with its still-pending Transaction.
 *
 * The gateway charge itself is not cancelled — it cannot be — but the webhook and
 * verify paths settle by payment number regardless of the local status, so a late
 * completion still credits correctly. `failed` is excluded from the in-flight sum,
 * the payments-per-plan budget, and the reuse/guard checks, so releasing here
 * unblocks all of them at once.
 *
 * Returns true when the plan was modified (and saved).
 */
async function releaseStalePayments(plan) {
  const stale = (plan?.installments || []).filter(entry => {
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

/**
 * Force-releases every in-flight attempt on a plan, regardless of age.
 *
 * Unlike releaseStalePayments — which only reaps attempts past the reuse window
 * because the payer might still be completing one — this acts on an explicit
 * human "cancel this attempt" decision, so there is no waiting period. The
 * settlement safety is identical: the gateway charge cannot be recalled, but the
 * webhook and verify paths settle by payment number regardless of the local
 * status, so a payment that lands after this still credits and enrolls correctly.
 *
 * Returns the number of attempts released (0 when there was nothing in flight, so
 * the caller can treat "already clear" as success).
 */
async function releaseInFlightPayments(plan) {
  const inFlight = (plan?.installments || []).filter(entry => entry.status === 'processing');
  if (!inFlight.length) return 0;

  for (const entry of inFlight) {
    entry.status = 'failed';
    if (entry.txRef) {
      await Transaction.updateOne({ txRef: entry.txRef, status: 'pending' }, { $set: { status: 'failed' } });
    }
  }
  await plan.save();
  return inFlight.length;
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
 *
 * The guard is keyed on the `enrollments` row — the thing this function
 * actually creates — not on `enrolledStudents` membership. Keying it on
 * `enrolledStudents` left two gaps: a student already in `enrolledStudents` but
 * missing from `enrollments` (drift from an older code path) could never be
 * repaired, and an `$ne`/`$addToSet` against an ObjectId misfired when the
 * stored ids were plain strings. Matching `enrollments.user` against both id
 * forms closes both — it still writes at most one row, and it now backfills a
 * missing enrollment row for an already-listed student.
 *
 * `renewal` takes the opposite branch: the student is already on the course, so
 * there is no row to create — the lapsed one is flipped back to active in place.
 * Reusing the create path here would have been silently wrong, because its
 * `$nin` guard makes it a no-op for exactly the people a renewal is for, leaving
 * the student charged with their access still expired.
 */
async function grantCourseAccess({ userId, courseId, plan, session, renewal = false }) {
  const options = session ? { session } : {};
  const [course, user] = await Promise.all([
    Course.findById(courseId).setOptions(options),
    User.findById(userId).setOptions(options),
  ]);
  if (!course || !user) throw new Error('Course or student not found');

  const enrollmentStatus = plan ? 'payment_plan_active' : 'active';

  if (renewal) {
    const renewedAt = new Date();
    // Conditional on the row still being lapsed, so two finalizers racing the
    // same payment cannot both report a renewal — the loser matches nothing.
    const renewed = await Course.updateOne(
      { _id: course._id, enrollments: { $elemMatch: { user: user._id, status: { $ne: 'active' } } } },
      {
        $set: {
          'enrollments.$.status': enrollmentStatus,
          'enrollments.$.enrolledOn': renewedAt,
          'enrollments.$.updatedAt': renewedAt,
        },
        $addToSet: { enrolledStudents: user._id },
      },
      options,
    );
    if (renewed.modifiedCount === 0) return false;

    try {
      await Notification.create({
        title: 'Course enrollment renewal',
        content: `${user.fullname} just renewed enrollment for your course ${course.title}`,
        contentId: course._id,
        userId: course.instructorId,
      });
    } catch (error) {
      console.error('Renewal notification failed:', error.message);
    }

    return true;
  }

  const result = await Course.updateOne(
    { _id: course._id, 'enrollments.user': { $nin: [user._id, String(user._id)] } },
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
    // Already has an enrollment row — another concurrent finalizer won the race,
    // or this is a replayed webhook. Nothing further to do.
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
 * How one settled payment is divided between the provider and their tutors.
 *
 * Pure, and exported, because this is the whole of the money rule and it should
 * be checkable without a database. Returns `[{ userId, amount, role, refSuffix }]`
 * in the order the credits should be written, always with the provider first.
 *
 * The order of operations is what makes the split fair:
 *
 *   1. the platform takes its fee off the gross, as it always has
 *   2. the tutor share is a percentage of what is *left* — the provider's own net
 *   3. the provider keeps the remainder
 *
 * Taking the share off the gross instead would pay the platform fee twice: once
 * out of the provider's side and once out of the tutor's.
 *
 * Several tutors on one course divide the one share equally rather than each
 * taking it. "20% to my tutors" is a statement about how much of the course
 * revenue leaves the provider, so two tutors on a course must not turn it into
 * 40%. The provider is skipped as a recipient: they are already the remainder,
 * and paying them a share would write two rows moving the same money.
 */
function splitCourseEarnings({
  amountMajor,
  instructorId,
  assignedTutors = [],
  revenueShare = {},
}) {
  const gross = Number(amountMajor);
  if (!(gross > 0)) return [];

  const net = roundMoney(gross * (1 - PLATFORM_FEE_RATE));
  const share = revenueShare?.enabled
    ? clampPercentage(revenueShare.percentage, MAX_SHARE_PERCENT)
    : 0;

  const tutorIds = [...new Set((assignedTutors || []).filter(Boolean).map((id) => String(id)))]
    .filter((id) => id !== String(instructorId));

  const shares = [];
  if (!tutorIds.length || share <= 0) {
    if (instructorId) shares.push({ userId: instructorId, amount: net, role: 'provider', refSuffix: '' });
    return shares;
  }

  // Kobo-rounded per tutor, and the *provider's* remainder is derived from what
  // the tutors actually receive rather than from the nominal percentage. That is
  // the only way the parts add up to the whole: three tutors on a 10% share of
  // ₦100.01 each round to a different kobo than 10% of the total, and the extra
  // kobo has to come out of somebody's side or the credits will not sum back to
  // the net. It comes out of the provider's, whose cut is the residual here.
  const perTutor = roundMoney(percentageOf(net, share) / tutorIds.length);
  const tutorTotal = roundMoney(perTutor * tutorIds.length);

  // The provider's row is written first and keeps the unsuffixed reference it
  // has always had, so anything reading a course credit by its txRef still finds
  // the provider's.
  const providerAmount = roundMoney(net - tutorTotal);
  // A share that consumed the whole net leaves the provider nothing to receive.
  // A zero-value ledger row would be noise, so none is written.
  if (instructorId && providerAmount > 0) {
    shares.push({ userId: instructorId, amount: providerAmount, role: 'provider', refSuffix: '' });
  }

  let paidToTutors = 0;
  tutorIds.forEach((id, index) => {
    // The last tutor absorbs the division remainder, so the tutor credits sum to
    // exactly `tutorTotal` and no kobo is created or lost by rounding.
    const amount = index === tutorIds.length - 1
      ? roundMoney(tutorTotal - paidToTutors)
      : perTutor;
    paidToTutors = roundMoney(paidToTutors + amount);
    if (amount > 0) {
      shares.push({ userId: id, amount, role: 'tutor', refSuffix: `-tutor-${id}` });
    }
  });

  return shares;
}

/**
 * Writes one credit and moves the balance behind it, exactly once.
 *
 * Idempotency is the unique txRef: a replayed webhook hits the duplicate-key
 * error and returns false without touching the balance. Each share carries its
 * own suffix, so the provider's row and a tutor's row are separately idempotent
 * — which is what lets a first run that died between the two be completed by the
 * replay rather than being abandoned as "already credited".
 */
async function creditShare(transaction, share, platformFee) {
  // Read fresh for each share: the credits are written in sequence, so the
  // running balance on each ledger row has to include the ones before it or the
  // wallet ledger stops reconciling line by line.
  const recipient = await User.findById(share.userId).select('balance');
  const balanceAfter = roundMoney((Number(recipient?.balance) || 0) + share.amount);

  try {
    await Transaction.create({
      userId: share.userId,
      courseId: transaction.courseId,
      amount: share.amount,
      type: 'credit',
      direction: 'credit',
      balanceAfter,
      status: 'successful',
      txRef: `course-credit-${transaction.txRef}${share.refSuffix}`,
      metadata: {
        sourceTransaction: transaction.txRef,
        grossAmount: Number(transaction.amount),
        platformFee,
        // Named so the wallet shows a tutor why the credit is smaller than the
        // course fee, and so support can tell a split from a whole credit.
        earningsRole: share.role,
        revenueSharePercent: share.role === 'tutor' ? share.percent : undefined,
      },
    });
  } catch (error) {
    if (error?.code === 11000) return false; // Already credited; webhook/redirect replay.
    throw error;
  }

  await User.findByIdAndUpdate(share.userId, { $inc: { balance: share.amount } });
  return true;
}

/**
 * Credits everyone who earned on this payment, exactly once per source payment.
 *
 * The provider receives their net minus the tutors' share; each assigned tutor
 * receives their cut. Every credit is independently idempotent, so a replay
 * completes a run that was interrupted part-way instead of skipping the rest.
 */
async function creditInstructor(transaction, amountMajor) {
  const course = await Course.findById(transaction.courseId)
    .select('instructorId assignedTutors');
  if (!course?.instructorId || !(amountMajor > 0)) return false;

  const provider = await User.findById(course.instructorId)
    .select('tutorRevenueShare');
  const revenueShare = provider?.tutorRevenueShare || {};

  const shares = splitCourseEarnings({
    amountMajor,
    instructorId: course.instructorId,
    assignedTutors: course.assignedTutors,
    revenueShare,
  });
  if (!shares.length) return false;

  const percent = revenueShare?.enabled
    ? clampPercentage(revenueShare.percentage, MAX_SHARE_PERCENT)
    : 0;
  const platformFee = roundMoney(Number(amountMajor) * PLATFORM_FEE_RATE);

  let creditedAny = false;
  for (const share of shares) {
    const written = await creditShare(
      transaction,
      { ...share, percent },
      platformFee,
    );
    creditedAny = creditedAny || written;
  }

  return creditedAny;
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

  await grantCourseAccess({
    userId: current.userId,
    courseId: current.courseId,
    renewal: current.metadata?.renewal === true,
  });
  await creditInstructor(current, Number(current.amount));

  // Affiliate commission, if the student was referred. Deliberately after the
  // instructor is credited and deliberately non-fatal: access is already granted
  // and the student's money has already been taken, so a commission failure must
  // not turn a successful payment into an error response. Its own write is
  // idempotent, so the webhook/redirect replay cannot double-pay the affiliate.
  try {
    await generateCommissionForPayment(current);
  } catch (error) {
    console.error('Affiliate commission generation failed:', current.txRef, error.message);
  }

  // Receipt is fire-and-forget and idempotent per transaction; the webhook and
  // the redirect both land here, so this is the one safe choke point for full
  // payments. Never block finalization on the mailer.
  sendPaymentReceiptOnce({ transaction: current, settledInFull: true });
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

    // Commission accrues per settled instalment, capped so the running total can
    // never exceed the commission on the full fee. The `updatedPlan` guard is
    // what keeps a replayed webhook from accruing twice for one instalment, and
    // the commission row's own unique key is the second line of defence.
    try {
      await generateCommissionForPayment(transaction, { plan: currentPlan });
    } catch (error) {
      console.error('Affiliate commission generation failed:', transaction.txRef, error.message);
    }
  }

  // Receipt is fire-and-forget and idempotent per transaction. The dispatcher
  // refetches the live transaction for its guard, so this call is safe to make
  // even on replays that did not win the plan update.
  const settledTransaction = await Transaction.findById(transaction._id);
  if (settledTransaction) {
    const outstanding = toMajorUnits(planOutstandingMinor(currentPlan));
    sendPaymentReceiptOnce({
      transaction: settledTransaction,
      plan: currentPlan,
      settledInFull: isSettled,
      balanceRemaining: outstanding,
    });
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
 *
 * The instructor's consent gate applies to *opening* a plan, not to keeping one
 * alive. A student who has already committed money — settled or in flight —
 * agreed to terms that were on offer at the time, and an instructor toggling
 * part payment off afterwards must not strand them with a balance they can no
 * longer pay. So a plan with money against it is always returned; only a brand
 * new plan, or an untouched one nobody has paid into, requires current consent.
 */
async function openPlanForStudent({ user, course, createdBy }) {
  const policy = resolvePartPaymentPolicy(course);

  const existing = await CoursePaymentPlan.findOne({
    userId: user._id,
    courseId: course._id,
    status: { $in: ['pending', 'active', 'overdue'] },
  });

  if (existing) {
    const hasCommittedMoney = Number(existing.amountPaidMinor) > 0
      || (existing.installments || []).some(entry => entry.status === 'processing');
    if (hasCommittedMoney) {
      if (refreshDueStatus(existing)) await existing.save();
      return existing;
    }
  }

  if (!policy.partPaymentEnabled) {
    throw Object.assign(
      new Error(
        toMinorUnits(course?.fee) > 0
          ? 'This course must be paid for in full'
          : 'This course does not require payment',
      ),
      { status: 400, code: 'PART_PAYMENT_DISABLED' },
    );
  }

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
  CHECKOUT_REUSE_WINDOW_MS,
  toMinorUnits,
  toMajorUnits,
  addDays,
  serializePlan,
  normalizePlan,
  refreshDueStatus,
  summarizeEnrollmentPaid,
  resolvePartPaymentPolicy,
  planOutstandingMinor,
  planInFlightMinor,
  releaseStalePayments,
  releaseInFlightPayments,
  nextPaymentNumber,
  minimumPaymentMinor,
  validatePaymentAmount,
  openPlanForStudent,
  grantCourseAccess,
  creditInstructor,
  splitCourseEarnings,
  finalizeFullCoursePayment,
  finalizeInstallmentPayment,
  hasActiveCourseAccess,
  resolveRedirectUrl,
  initializeGatewayCheckout,
};
