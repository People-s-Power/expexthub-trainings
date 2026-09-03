// Welcome / onboarding email.
//
// Sent once, after the account email is verified (or immediately for Google
// signups, which arrive pre-verified). The copy and call to action are tuned by
// role: students are pointed at exploring courses, tutors at completing their
// profile so they can publish.
const {
  sendMail,
  renderLayout,
  plainTextFallback,
  formatNaira,
} = require('./mailer.js');

// Public URL configuration. TRAINING_URL is the trainings app; FRONTEND_URL the
// marketing/institute site. Both are already required by CORS and redirect
// logic elsewhere in the API, so they are the source of truth here too.
const brandHomeUrl = (process.env.FRONTEND_URL || 'https://experthubllc.com').replace(/\/$/, '');
const trainingUrl = (process.env.TRAINING_URL || 'https://trainings.experthubllc.com').replace(/\/$/, '');
const logoUrl = `${trainingUrl}/images/logo.png`;
const supportEmail = process.env.MAIL_SUPPORT_EMAIL || 'support@experthubllc.com';

function firstNameOf(fullname) {
  if (!fullname) return 'there';
  const first = String(fullname).trim().split(/\s+/)[0];
  return first || 'there';
}

/**
 * Sends the account-onboarding email.
 *
 * @param {Object} user - { email, fullname, role }
 * @returns {Promise} nodemailer send result
 */
/**
 * Sends the account-onboarding email.
 *
 * @param {Object} user - { email, fullname, role }
 * @param {Object} [opts]
 * @param {boolean} [opts.activationPending] - true when the recipient has just
 *   registered but has not yet entered their email code; changes the message to
 *   a "verify to finish signing up" variant.
 * @param {string} [opts.ctaUrl] - overrides the default call-to-action link.
 * @param {string} [opts.ctaLabel] - overrides the default CTA label.
 * @returns {Promise} nodemailer send result
 */
async function sendWelcomeEmail(user, opts = {}) {
  if (!user?.email) throw new Error('Welcome email recipient is required');

  const role = String(user.role || '').toLowerCase();
  const isTutor = role === 'tutor' || role === 'provider' || role === 'team_member';
  const activationPending = opts.activationPending === true;

  // Different CTAs per role/state (front-end routes mirror the role dashboards).
  let ctaUrl;
  let ctaLabel;
  if (activationPending) {
    ctaUrl = opts.ctaUrl || `${trainingUrl}/auth/login`;
    ctaLabel = opts.ctaLabel || 'Go to my dashboard';
  } else if (isTutor) {
    ctaUrl = opts.ctaUrl || `${trainingUrl}/tutor/profile`;
    ctaLabel = opts.ctaLabel || 'Complete your profile';
  } else {
    ctaUrl = opts.ctaUrl || `${trainingUrl}/courses`;
    ctaLabel = opts.ctaLabel || 'Explore courses';
  }

  const data = {
    subject: activationPending
      ? 'Welcome to Experthub Trainings — verify your email'
      : isTutor
        ? 'Welcome to Experthub Trainings — let\'s get you teaching'
        : 'Welcome to Experthub Trainings — let\'s get started',
    preheader: activationPending
      ? 'Your account is almost ready. Enter the code we emailed you to activate it.'
      : isTutor
        ? 'Your trainer account is ready. Set up your profile and publish your first course.'
        : 'Your account is ready. Explore courses and start learning today.',
    firstName: firstNameOf(user.fullname),
    heading: isTutor ? 'Welcome, Trainer!' : 'Welcome to Experthub!',
    isTutor,
    activationPending,
    expiryMinutes: opts.expiryMinutes || 15,
    email: user.email,
    brandHomeUrl,
    logoUrl,
    supportEmail,
    ctaUrl,
    ctaLabel,
  };

  const html = renderLayout('welcome', data);
  const text = plainTextFallback([
    `Hi ${data.firstName},`,
    activationPending
      ? `Thanks for creating your Experthub account. To activate it, enter the code emailed to ${user.email}. It expires in ${data.expiryMinutes} minutes.`
      : 'Welcome to Experthub Trainings! Your account is verified and ready to go.',
    activationPending
      ? `Go to your dashboard: ${data.ctaUrl}`
      : isTutor
        ? 'Set up your profile so students can discover you, then publish your first course and start teaching.'
        : 'Browse industry-led courses, learn at your own pace and grow skills that move your career forward.',
    !activationPending ? (isTutor ? `Complete your profile: ${data.ctaUrl}` : `Explore courses: ${data.ctaUrl}`) : null,
    `If you have any questions, reach us at ${supportEmail}.`,
    'The Experthub Trainings Team',
  ]);

  return sendMail({
    to: user.email,
    subject: data.subject,
    html,
    text,
    replyTo: supportEmail,
  });
}

/**
 * Sends the welcome email at most once per account.
 *
 * The check-and-set uses a single atomic update on `welcomeEmailSentAt` so two
 * concurrent verifications (e.g. the signup verify page and a resend racing)
 * cannot both deliver a welcome. The email itself is sent first, then the flag
 * is persisted, so a failed send does not permanently suppress a retry.
 *
 * @param {Object} user a hydrated Mongoose user document (must be `.save()`able)
 * @param {Object} [opts] forwarded to sendWelcomeEmail
 */
async function sendWelcomeEmailOnce(user, opts = {}) {
  if (!user?._id || !user?.email) return false;
  if (user.welcomeEmailSentAt) return false;

  await sendWelcomeEmail(user, opts);

  // Update on the database row so the in-memory doc and any other holder of the
  // same account agree on the flag.
  const User = require('../../models/user.js');
  const updated = await User.updateOne(
    { _id: user._id, welcomeEmailSentAt: { $exists: false } },
    { $set: { welcomeEmailSentAt: new Date() } },
  );
  user.welcomeEmailSentAt = new Date();
  return updated.modifiedCount > 0;
}

module.exports = {
  sendWelcomeEmail,
  sendWelcomeEmailOnce,
  firstNameOf,
  brandHomeUrl,
  trainingUrl,
  logoUrl,
  supportEmail,
  formatNaira,
};
