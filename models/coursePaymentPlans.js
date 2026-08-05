const mongoose = require('mongoose');

const installmentSchema = new mongoose.Schema({
  number: { type: Number, required: true, min: 1, max: 3 },
  amountMinor: { type: Number, required: true, min: 1 },
  dueAt: { type: Date, required: true },
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
  installmentCount: { type: Number, default: 3, immutable: true },
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
  installments: {
    type: [installmentSchema],
    validate: value => Array.isArray(value) && value.length === 3,
  },
  lastPaymentAt: Date,
}, { timestamps: true });

// A student can have one live plan for a course. Historical cancelled plans remain auditable.
coursePaymentPlanSchema.index(
  { userId: 1, courseId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'active', 'overdue'] } } },
);
coursePaymentPlanSchema.index({ 'installments.txRef': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('CoursePaymentPlan', coursePaymentPlanSchema);
