const mongoose = require('mongoose');

/**
 * One part payment a student committed to.
 *
 * The collection is still called `installments` and the entries are still keyed
 * by `number` because in-flight gateway transactions reference that number, and
 * renumbering or renaming would orphan a webhook mid-flight. Entries are only
 * created when a student actually starts a payment — there are no placeholder
 * rows for money nobody has committed to yet.
 */
const partPaymentSchema = new mongoose.Schema({
  // Not dense: numbers are stable identifiers, so pruning never re-uses one.
  number: { type: Number, required: true, min: 1, max: 100 },
  amountMinor: { type: Number, required: true, min: 1 },
  // Legacy schedules carried a due date per instalment. Student-chosen payments
  // are due immediately, so this is only populated on pre-existing documents.
  dueAt: { type: Date },
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'failed', 'overdue'],
    default: 'pending',
  },
  txRef: { type: String, index: true },
  gatewayTransactionId: String,
  paidAt: Date,
  attempts: { type: Number, default: 0 },
  lastAttemptAt: Date,
}, { _id: false });

const coursePaymentPlanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  currency: { type: String, default: 'NGN', uppercase: true },
  // Snapshotted at creation: a later fee change must not move the goalposts for
  // a student who has already started paying.
  totalAmountMinor: { type: Number, required: true, min: 1 },
  amountPaidMinor: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ['pending', 'active', 'completed', 'overdue', 'cancelled'],
    default: 'pending',
    index: true,
  },
  accessStatus: {
    type: String,
    enum: ['provisional', 'active', 'suspended'],
    default: 'provisional',
  },
  priceSnapshot: {
    courseTitle: String,
    courseFee: Number,
  },
  installments: { type: [partPaymentSchema], default: [] },
  firstPaymentAt: Date,
  lastPaymentAt: Date,
  // The balance must be cleared by this date. Set from the first settled payment
  // and never extended, so a plan has a definite end.
  settlementDueAt: { type: Date, index: true },
  // Set when a tutor or admin opened the plan on the student's behalf while
  // recording an offline payment, so manual enrolments stay auditable.
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// A student can have one live plan for a course. Historical cancelled plans remain auditable.
coursePaymentPlanSchema.index(
  { userId: 1, courseId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'active', 'overdue'] } } },
);
coursePaymentPlanSchema.index({ 'installments.txRef': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('CoursePaymentPlan', coursePaymentPlanSchema);
