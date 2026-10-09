const mongoose = require('mongoose');

/**
 * One tutor earning accrued on one settled payment.
 *
 * The tutor programme's mirror of `affiliateCommission`, and deliberately so: the
 * two are the only places this platform moves money out of a payment to a third
 * party, and a provider reading either screen should be able to reason about them
 * the same way. The lifecycle is identical —
 *
 *   pending → (holdUntil elapses) → available → (payout confirmed) → withdrawn
 *                                              ↘ reversed (a compensating row)
 *
 * — and so are the two properties that matter most:
 *
 *  - `earningRef` is unique. It is derived from the source payment's `txRef` and
 *    the tutor, so a replayed gateway webhook hits a duplicate-key error (11000)
 *    instead of paying the tutor twice. This is the same idempotency trick the
 *    affiliate ledger and the course ledger use, and it is why this collection is
 *    safe to write from a webhook.
 *
 *  - The rate is *snapshotted* onto the row (`rateType` / `rateValue`), not read
 *    back from settings at payout time. A provider changing their revenue share
 *    later must not rewrite what a past payment earned.
 *
 * `baseAmount` and `amount` are in **minor units** (kobo) to match the payment
 * tables; formatting to naira happens at the edge.
 */
const tutorEarningSchema = new mongoose.Schema(
  {
    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The student whose payment earned this — the payer, since a tutor is paid on
    // every sale of a course they are assigned to, not on a referral.
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', index: true },
    // The course's owner. Held here rather than reached through `courseId` because
    // this is what scopes the provider's My Instructors screen, and a join per row
    // to answer "is this mine?" is the kind of thing that quietly returns somebody
    // else's rows when it is got wrong. It is written from the course at accrual
    // time and is a plain ObjectId, so there is no second spelling to reconcile.
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    paymentPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoursePaymentPlan' },
    installmentNumber: { type: Number },

    // The payment this earning was accrued on. Stored as the txRef string rather
    // than an ObjectId because the txRef is what the webhook is keyed by.
    sourceTransaction: { type: String, required: true, index: true },

    // The student fee for this payment — the figure the rate was applied to, and
    // the "Student fee" column on the My Instructors table. Under a percentage
    // rate it is the gross the student paid, which is what the share is a
    // proportion of.
    baseAmount: { type: Number, required: true, min: 0 },
    // `fixed` is a flat fee for the course rather than a proportion of this
    // payment, so `rateValue` is naira in that case and a percentage in the other.
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

    // When the holding period elapses and the earning becomes withdrawable.
    // Indexed alongside status because the release sweep queries exactly this pair.
    holdUntil: { type: Date, index: true },
    releasedAt: { type: Date },
    withdrawnAt: { type: Date },
    // The withdrawal whose payout consumed this earning. Recorded because a
    // payout can still fail after it was requested, and putting the rows back
    // means knowing which ones that withdrawal took — without this the only
    // option would be to guess, or to leave a failed payout looking withdrawn.
    withdrawnByRef: { type: String, index: true },
    reversedAt: { type: Date },
    reversalReason: String,
    // The earning row this one compensates, on a reversal.
    reverses: { type: String },
    // Set on the *original* row when it is reversed, pointing at the compensating
    // row. Its presence is also the guard that stops a second reversal.
    reversalRef: { type: String },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Which tier of the resolution order supplied the rate, kept for support
    // ("why did this pay 50%?"). Purely explanatory. There is no platform default
    // on this programme — a provider who never opted in pays nothing — so these
    // are the only two a tutor earning can carry.
    rateSource: {
      type: String,
      enum: ['course_override', 'provider'],
    },

    earningRef: { type: String, unique: true, sparse: true, index: true },
    currency: { type: String, default: 'NGN' },
    metadata: { type: mongoose.Schema.Types.Mixed },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// The release sweep: pending rows whose hold has matured. A compound index lets
// that be one range scan rather than a scan of every earning ever written.
tutorEarningSchema.index({ status: 1, holdUntil: 1 });
// The tutor's own earnings screens, newest first.
tutorEarningSchema.index({ tutorId: 1, createdAt: -1 });
// The provider's My Instructors table. Same shape, scoped to the course owner.
tutorEarningSchema.index({ providerId: 1, createdAt: -1 });
// The accrual read: how much this student's tutoring on this course has already
// earned, which decides the once-per-course fixed fee and the per-student cap.
// Matched by (student, course) rather than by tutor because both rules are about
// the course's pool of tutors, not about any one of them.
tutorEarningSchema.index({ courseId: 1, studentId: 1, status: 1 });

const TutorEarning = mongoose.model('TutorEarning', tutorEarningSchema);

module.exports = TutorEarning;
