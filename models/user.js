const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: String,
  organizationName: {
    type: String,
    required: false,
  },
  orgUrl: {
    type: String,
  },
  email: String,
  fullname: String,
  name: String,
  companyName: String,
  gender: String,
  age: String,
  premiumPlan: {
    type: String,
    default: "basic"
  },
  flutterwaveSubscriptionId: {
    type: String,
    required: false,
    // Activation checks this to make sure a subscription is not already backing
    // another account, so it is looked up by value on every upgrade.
    index: true
  },
  isYearly: {
    type: String,
    required: false
  },
  premiumPlanExpires: {
    type: Date,
    required: false

  },
  phone: {
    type: String,
    default: ""
  },
  gender: String,
  age: String,
  skillLevel: String,
  country: String,
  state: String,
  address: {
    type: String,
    default: ""
  },
  password: String,
  // Indexed: the platform filters by role constantly (the Enrol Student list,
  // instructor lists, admin dashboards), and without an index each of those is
  // a full collection scan.
  role: { type: String, index: true },
  googleId: String,
  bankCode: String,
  // Name of the bank behind `bankCode`, captured alongside the account so the
  // withdrawal screen can show a destination without re-resolving it.
  bankName: String,
  profilePicture: String,
  image: String,

  assignedWorkspace: String,
  // Primary course category chosen at signup (applicant step 3) or in the
  // survey. Declared here so Mongoose persists it — under strict mode a write to
  // an undeclared path is silently dropped, which previously lost the category.
  assignedCourse: String,
  otherCourse: [{
    type: String
  }],
  otherWorkspace: [{
    type: String
  }],
  accountNumber: String,
  // Name the bank reports for `accountNumber`, captured when the payout account is
  // saved. Stored so a withdrawal can show the destination without a re-resolve.
  accountName: String,
  assessmentAnswers: {
    type: [String], // Array to store user's assessment answers
  },
  survey: {
    // computerAccess: Boolean,
    // internetAccess: Boolean,
    gender: String,
    employmentStatus: String,
    trainingHours: String,
    age: String,
    preferedCourse: String,
    yearsOfExperience: String,
    currentEducation: String,
    joiningAccomplishment: String,
  },
  balance: { type: Number, default: 0 },
  // Set when a training provider created this account from the admissions flow
  // rather than the person signing themselves up. Kept for audit: it is the only
  // record of who vouched for an account that was marked verified on creation.
  registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ---------------------------------------------------------------------------
  // Affiliate programme
  // ---------------------------------------------------------------------------

  // Public serial for an affiliate ("EXP-P-000125"). Unique but sparse: the vast
  // majority of accounts are not affiliates and must not collide on `null`.
  affiliateId: { type: String, unique: true, sparse: true, index: true },
  // Short code that appears in the affiliate's public referral link. Also sparse,
  // for the same reason, and issued only on approval so an unapproved affiliate
  // has no working link.
  affiliateCode: { type: String, unique: true, sparse: true, index: true },

  // Application and standing for the affiliate persona. Absent on every other
  // role, which is why this is a subdocument rather than top-level columns.
  affiliateProfile: {
    type: {
      type: String,
      enum: ['individual', 'organisation'],
      default: 'individual',
    },
    businessName: String,
    // Where the person heard about the programme — kept for marketing, not auth.
    referralSource: String,
    promotionMethod: String,
    audienceSize: String,
    website: String,
    socialLinks: {
      facebook: String,
      instagram: String,
      twitter: String,
      linkedin: String,
      tiktok: String,
      whatsapp: String,
    },
    payoutPreference: String,
    // `pending` → awaiting review; `approved` → may refer and earn; `suspended`
    // → existing attribution and earnings survive but no new referrals count.
    status: {
      type: String,
      enum: ['pending', 'under_review', 'approved', 'rejected', 'suspended'],
      default: 'pending',
      index: true,
    },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewNote: String,
    rejectionReason: String,
    approvedAt: Date,
    suspendedAt: Date,
    suspensionReason: String,
  },

  // Commission terms for this user's *own* courses — i.e. the training provider's
  // control over what affiliates earn from their courses (spec §4/§13). Held on
  // the provider rather than in a settings collection so a provider's terms travel
  // with their account and cannot be orphaned.
  affiliateSettings: {
    // The provider's master switch. `false` means no commission is ever generated
    // for their courses, whatever the other fields say.
    enabled: { type: Boolean, default: true },
    defaultCommissionType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    defaultCommissionRate: { type: Number, min: 0, default: 0 },
    // Optional ceiling in naira on a single commission. 0 means "no cap".
    maxCommissionCap: { type: Number, min: 0, default: 0 },
    // Holding period before earnings become withdrawable. Null falls back to the
    // platform default, so an unset provider still behaves predictably.
    holdDays: { type: Number, min: 0, max: 90, default: null },
    // A one-off override applied to a specific affiliate, keyed by user id. Read
    // before the category and default tiers of the resolution order.
    affiliateOverrides: [
      {
        affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        type: { type: String, enum: ['percentage', 'fixed'] },
        value: { type: Number, min: 0 },
      },
    ],
    updatedAt: Date,
  },

  // Who referred this student. Deliberately separate from `registeredBy`:
  // `registeredBy` records who *created* the account (a provider enrolling a
  // student), while this records who *referred* them. Conflating the two would
  // misattribute every provider-enrolled student to that provider as an affiliate.
  // Indexed because the affiliate's whole student list and every commission query
  // filters on it.
  referredByAffiliate: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  // What the person declared at signup, retained verbatim for audit even when it
  // is superseded by a stronger signal (a referral-link click).
  referral: {
    // Explicitly answered, not inferred. `null` means the question was never put
    // to this account (every role other than student/client).
    declared: { type: Boolean, default: null },
    isReferred: { type: Boolean, default: null },
    // 'link' when a referral token resolved server-side, 'self_declared' when the
    // student picked an affiliate from the list, 'provider_assisted' when a
    // provider selected one while enrolling them, 'affiliate_enrolled' when the
    // affiliate added the student themselves from their admissions module.
    source: {
      type: String,
      enum: ['link', 'self_declared', 'provider_assisted', 'affiliate_enrolled', null],
      default: null,
    },
    affiliateCode: String,
    declaredAt: Date,
  },

  // Where this student is in the admissions journey. Drives the affiliate's
  // admissions board and the provider's enrolment view.
  //
  // `history` is append-only: every transition is pushed with who made it and
  // when, so a status can always be explained after the fact. The spec requires
  // the journey to be traceable, and an overwritten status field would lose it.
  admission: {
    status: {
      type: String,
      enum: [
        'lead',
        'application_started',
        'application_submitted',
        'under_review',
        'admitted',
        'awaiting_payment',
        'registered',
        'training_started',
        'completed',
        // Terminal states. Kept distinct from each other because they mean
        // different things operationally: a rejected applicant was turned down,
        // a withdrawn one left of their own accord, and a cancelled one never
        // really started.
        'rejected',
        'withdrawn',
        'cancelled',
      ],
      default: 'lead',
      index: true,
    },
    // Free-text the affiliate or provider keeps against the applicant.
    notes: String,
    interestedCourse: String,
    // When the applicant is expected to begin, as a plain date string to match
    // how the rest of the platform stores course dates.
    intendedStartDate: String,
    updatedAt: Date,
    history: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byRole: String,
        note: String,
      },
    ],
  },
  // Scheduled payouts. Manual withdrawal is untouched by this — auto payout is an
  // extra trigger that runs the same debit-then-transfer path, never a replacement.
  //
  // `nextRunAt` is the only field the scheduler queries on: it is recomputed from
  // the schedule every time the settings change and after every run, so a sweep is
  // one indexed range scan instead of evaluating a cron rule per user. A payout
  // that fires is deliberately *not* retried before the following slot — a failed
  // transfer already releases the hold, and retrying inside the same window is how
  // one bad bank response turns into a stream of duplicate attempts.
  autoPayout: {
    enabled: { type: Boolean, default: false },
    // daily → every day at the chosen time; weekly → `dayOfWeek`; monthly → `dayOfMonth`.
    frequency: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'weekly' },
    // 0 = Sunday … 6 = Saturday, matching Date#getDay.
    dayOfWeek: { type: Number, min: 0, max: 6, default: 5 },
    // Capped at 28 so every month has the day — a 31st schedule would silently skip February.
    dayOfMonth: { type: Number, min: 1, max: 28, default: 1 },
    hour: { type: Number, min: 0, max: 23, default: 9 },
    minute: { type: Number, min: 0, max: 59, default: 0 },
    // Fixed offset in minutes east of UTC for the user's payout clock. Nigeria (WAT)
    // is +60 and observes no DST, which is why a plain offset is enough here.
    utcOffsetMinutes: { type: Number, min: -720, max: 840, default: 60 },
    // Skip the run when the wallet holds less than this (naira). Stops a schedule
    // from firing a string of near-empty transfers and burning gateway fees.
    minimumAmount: { type: Number, min: 500, default: 5000 },
    // Blank/0 means "sweep the whole balance". Otherwise pay out at most this much.
    maximumAmount: { type: Number, min: 0, default: 0 },
    nextRunAt: { type: Date, index: true },
    lastRunAt: Date,
    lastStatus: { type: String, enum: ['queued', 'successful', 'failed', 'skipped', null], default: null },
    lastMessage: String,
    lastAmount: Number,
  },
  contact: {
    type: Boolean,
    default: true
  },
  aptitudeTest: {
    willDadicate6Hours: String,
    describeSelf: String,
    personality: String,
    doForFun: String,
  },

  isVerified: {
    type: Boolean,
    default: false,
  },
  // Set once the account-onboarding email has been delivered, so a replay of a
  // verification request (or a re-login that confirms an already-verified email)
  // never spams the user with a second welcome message.
  welcomeEmailSentAt: {
    type: Date,
  },
  graduate: {
    type: Boolean,
    default: false,
  },
  blocked: {
    type: Boolean,
    default: false
  },
  verificationCode: {
    type: String,
    default: ""
  },
  // Codes are short-lived and rate-limited so a six-digit secret cannot be
  // brute-forced. Absent on accounts whose code predates these fields, which the
  // controller treats as "no expiry recorded" rather than locking them out.
  verificationCodeExpiresAt: {
    type: Date,
  },
  verificationCodeSentAt: {
    type: Date,
  },
  // Wrong guesses against the current code. Reset whenever a new code is issued.
  verificationAttempts: {
    type: Number,
    default: 0,
  },
  days: [{
    checked: Boolean,
    day: String,
    startTime: String,
    endTime: String
  }],
  mode: [{
    checked: Boolean,
    name: String
  }],
  teamMembers: [{
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // The category/role of the invited member (e.g. tutor, client, student,
    // provider, admin). Kept alongside tutorId so existing integrations keep
    // working while the platform supports adding any category as a team member.
    memberRole: {
      type: String,
      default: 'tutor',
    },
    status: String,
    privileges: [{
      checked: Boolean,
      value: String,
    }]
  }],
  location: String,
  room: String,
  signature: String,
  googleId: String,
  gMail: String,

  googleAccessToken: String,
  googleRefreshToken: String,
  isGoogleLinked: { type: Boolean, default: false },
});

const User = new mongoose.model("User", userSchema);

module.exports = User;