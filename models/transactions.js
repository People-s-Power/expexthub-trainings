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
  // Which way the money moved, as a plain ledger fact independent of the free-form
  // `type` string. Deliberately NOT `required`: rows written before this field
  // existed (course payments, admin credits, …) have no direction and must still
  // load. New wallet ledger rows always set it explicitly.
  direction: { type: String, enum: ['credit', 'debit'], required: false, default: null, index: true },
  // The wallet balance the user held after this row was applied, so the ledger
  // can be reconciled line-by-line without replaying every earlier transaction.
  // Null on course payments to instructors/students, which do not touch the wallet.
  balanceAfter: { type: Number, required: false },
  // External leg of an operation (e.g. the Flutterwave transfer reference echoed
  // back by the bank). Kept separate from `txRef`, which is our own unique key.
  reference: { type: String, required: false, index: true },
  soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  date: { type: Date, default: Date.now },
  paidAt: { type: Date },
  txRef: { type: String, unique: true, sparse: true, index: true },
  gatewayTransactionId: { type: String, index: true },
  status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'pending', index: true },
  currency: { type: String, default: 'NGN' },
  metadata: { type: mongoose.Schema.Types.Mixed },
  // Set when the payment-receipt email has been delivered for this transaction.
  // Guards the webhook/redirect replay paths so a student only ever receives one
  // receipt per payment.
  receiptEmailSentAt: { type: Date },
});

// Serves the "has this student paid for this course?" entitlement check and the
// wallet history screen without a collection scan.
transactionSchema.index({ userId: 1, courseId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, date: -1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
module.exports = Transaction;
