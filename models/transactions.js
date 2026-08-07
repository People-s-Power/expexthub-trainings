const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: false, index: true },
  paymentPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoursePaymentPlan', required: false, index: true },
  // Sequence number of a part payment within its plan. Bounded generously: the
  // real ceiling on payments per plan is enforced in the payment service.
  installmentNumber: { type: Number, required: false, min: 1, max: 100 },
  amount: Number,
  type: String,
  soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  date: { type: Date, default: Date.now },
  paidAt: { type: Date },
  txRef: { type: String, unique: true, sparse: true, index: true },
  gatewayTransactionId: { type: String, index: true },
  status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'pending', index: true },
  currency: { type: String, default: 'NGN' },
  metadata: { type: mongoose.Schema.Types.Mixed },
});

// Serves the "has this student paid for this course?" entitlement check and the
// wallet history screen without a collection scan.
transactionSchema.index({ userId: 1, courseId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, date: -1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
module.exports = Transaction;
