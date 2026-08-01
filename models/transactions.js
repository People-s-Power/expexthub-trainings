const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: false },
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
