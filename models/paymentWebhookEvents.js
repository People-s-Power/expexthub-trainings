const mongoose = require('mongoose');

const paymentWebhookEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  provider: { type: String, default: 'flutterwave' },
  status: { type: String, enum: ['received', 'processed', 'failed'], default: 'received', index: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  processedAt: Date,
  error: String,
}, { timestamps: true });

module.exports = mongoose.model('PaymentWebhookEvent', paymentWebhookEventSchema);
