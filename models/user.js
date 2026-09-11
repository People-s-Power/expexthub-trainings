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
    required: false
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