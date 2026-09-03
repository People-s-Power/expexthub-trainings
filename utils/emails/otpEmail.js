// Branded OTP verification email.
//
// Renders the same six-digit code the app has always emailed, but inside the
// shared ExpertHub layout so the verification message matches the onboarding
// and payment emails. The exported signature mirrors the old helper
// (`to`, `code`) so controllers keep working unchanged.
const {
  sendMail,
  renderLayout,
  plainTextFallback,
} = require('./mailer.js');

const brandHomeUrl = (process.env.FRONTEND_URL || 'https://experthubllc.com').replace(/\/$/, '');
const trainingUrl = (process.env.TRAINING_URL || 'https://trainings.experthubllc.com').replace(/\/$/, '');
const logoUrl = `${trainingUrl}/images/logo.png`;
const supportEmail = process.env.MAIL_SUPPORT_EMAIL || 'support@experthubllc.com';

const CODE_TTL_MINUTES = 15;

/**
 * Sends the verification/OTP email.
 *
 * @param {string} to recipient address
 * @param {string} code the six-digit verification code
 * @param {Object} [options] { purpose, fullName }
 *   purpose: 'signup' (default) | 'signin' | 'password_reset' | 'email_change'
 *            - used only to tune the greeting/copy
 * @returns {Promise} nodemailer send result
 */
async function sendOtpEmail(to, code, options = {}) {
  if (!to || !code) throw new Error('Verification email recipient and code are required');

  const purpose = String(options.purpose || 'signup');
  const name = options.fullName ? String(options.fullName).trim().split(/\s+/)[0] : '';

  let heading = 'Verify your email';
  let intro = 'Use the code below to verify your email address:';
  let subject = 'Your ExpertHub verification code';

  if (purpose === 'password_reset') {
    heading = 'Reset your password';
    intro = 'Use the code below to reset your password:';
    subject = 'Reset your ExpertHub password';
  } else if (purpose === 'signin') {
    heading = 'Sign-in verification code';
    intro = 'Use the code below to finish signing in:';
    subject = 'Your ExpertHub sign-in code';
  } else if (purpose === 'email_change') {
    heading = 'Verify your new email';
    intro = 'Use the code below to confirm your new email address:';
    subject = 'Verify your new ExpertHub email';
  }

  const data = {
    subject,
    preheader: `${code} is your ExpertHub verification code`,
    emailHeading: heading,
    emailIntro: intro,
    firstName: name,
    email: to,
    code: String(code),
    expiryMinutes: CODE_TTL_MINUTES,
    brandHomeUrl,
    logoUrl,
    supportEmail,
  };

  const html = renderLayout('otp', data);
  const text = plainTextFallback([
    name ? `Hi ${name},` : 'Hi,',
    `${heading}.`,
    intro,
    `Your code is: ${code}`,
    `It expires in ${CODE_TTL_MINUTES} minutes and can only be used once.`,
    'If you did not request this code, you can safely ignore this email.',
    'The ExpertHub Trainings Team',
  ]);

  return sendMail({
    to,
    subject,
    html,
    text,
    replyTo: supportEmail,
  });
}

module.exports = {
  sendOtpEmail,
  brandHomeUrl,
  trainingUrl,
  logoUrl,
  supportEmail,
};
