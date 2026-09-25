const mongoose = require('mongoose');

/**
 * One affiliate commission earned on one settled payment.
 *
 * Two properties matter more than the rest:
 *
 *  - `commissionRef` is unique. It is derived from the source payment's `txRef`,
 *    so a replayed gateway webhook hits a duplicate-key error (11000) instead of
 *    paying the affiliate twice. This is the same idempotency trick the course
 *    ledger uses, and it is why this collection is safe to write from a webhook.
 *
 *  - The rate is *snapshotted* onto the row (`rateType` / `rateValue`), not read
 *    back from settings at payout time. A provider changing their commission later
 *    must not rewrite what a past payment earned.
 *
 * `baseAmount` and `amount` are in **minor units** (kobo) to match the payment
 * tables; formatting to naira happens at the edge.
 */
const affiliateCommissionSchema = new mongoose.Schema(
  {
    affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The referred student whose payment earned this. Attribution is per-student,
    // so this is the student that was referred, not merely the payer of a course.
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', index: true },
    paymentPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoursePaymentPlan' },
    installmentNumber: { type: Number },

    // The payment this commission was earned on. Stored as the txRef string
    // rather than an ObjectId because the txRef is what the webhook is keyed by.
    sourceTransaction: { type: String, required: true, index: true },

    baseAmount: { type: Number, required: true, min: 0 },
    rateType: { type: String, enum: ['percentage', 'fixed'], required: true },
    rateValue: { type: Number, required: true, min: 0 },
    // Signed: a reversal row carries a negative amount, so summing this field
    // yields the true net earned without special-casing reversals.
    amount: { type: Number, required: true },

    status: {
      type: String,
      enum: ['pending', 'available', 'withdrawn', 'reversed'],
      default: 'pending',
      index: true,
    },

    // When the holding period elapses and the earnings become withdrawable.
    // Indexed alongside status because the release sweep queries exactly this pair.
    holdUntil: { type: Date, index: true },
    releasedAt: { type: Date },
    withdrawnAt: { type: Date },
    reversedAt: { type: Date },
    reversalReason: String,
    // The commission row this one compensates, on a reversal.
    reverses: { type: String },
    // Set on the *original* row when it is reversed, pointing at the compensating
    // row. Its presence is also the guard that stops a second reversal.
    reversalRef: { type: String },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Which tier of the resolution order supplied the rate, kept for support
    // ("why did this pay 10%?"). Purely explanatory.
    rateSource: {
      type: String,
      enum: ['course_override', 'affiliate', 'category', 'provider', 'platform'],
    },

    commissionRef: { type: String, unique: true, sparse: true, index: true },
    currency: { type: String, default: 'NGN' },
    metadata: { type: mongoose.Schema.Types.Mixed },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// The release sweep: pending rows whose hold has matured. A compound index lets
// that be one range scan rather than a scan of every commission ever written.
affiliateCommissionSchema.index({ status: 1, holdUntil: 1 });
// The affiliate's own earnings screens, newest first.
affiliateCommissionSchema.index({ affiliateId: 1, createdAt: -1 });

const AffiliateCommission = mongoose.model('AffiliateCommission', affiliateCommissionSchema);

module.exports = AffiliateCommission;
