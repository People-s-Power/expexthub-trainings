const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: false },
  paymentPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoursePaymentPlan', required: false, index: true },
  installmentNumber: { type: Number, required: false, min: 1, max: 3 },
  amount: Number,
  type: String,
  soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  date: { type: Date, default: Date.now },
  txRef: { type: String, unique: true, sparse: true, index: true },
  gatewayTransactionId: { type: String, index: true },
  status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'pending', index: true },
  currency: { type: String, default: 'NGN' },
  metadata: { type: mongoose.Schema.Types.Mixed },
});

const Transaction = mongoose.model('Transaction', transactionSchema);
module.exports = Transaction;
