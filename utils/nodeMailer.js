const { sendOtpEmail } = require('./emails/otpEmail.js');

// Kept as a thin facade so existing imports (`sendVerificationEmail`) keep
// working. The actual branded rendering and transport live in
// utils/emails/*, which is shared by the onboarding and receipt emails.
const sendVerificationEmail = (to, code, options) => sendOtpEmail(to, code, options);

module.exports = {
  sendVerificationEmail,
};
