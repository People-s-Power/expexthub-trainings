const nodemailer = require('nodemailer');

const verificationEmailUser = process.env.VERIFICATION_EMAIL_USER || 'verify@experthubllc.com';
const verificationEmailFrom = process.env.VERIFICATION_EMAIL_FROM || verificationEmailUser;

// Private Email uses implicit TLS on port 465. Leaving `secure` unset makes
// Nodemailer attempt a plain connection first, which commonly results in OTP
// requests timing out in production while the frontend remains on its spinner.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mail.privateemail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
  auth: {
    user: verificationEmailUser,
    pass: process.env.NOTIFICATION_EMAIL_PASSWORD,
  },
});

const sendVerificationEmail = async (to, code) => {
  if (!to || !code) throw new Error('Verification email recipient and code are required');
  if (!process.env.NOTIFICATION_EMAIL_PASSWORD) {
    throw new Error('NOTIFICATION_EMAIL_PASSWORD is not configured');
  }

  const mailOptions = {
    from: verificationEmailFrom,
    to,
    subject: 'Your Experthub verification code',
    text: `Your Experthub verification code is: ${code}. It expires in 15 minutes.`,
  };

  return transporter.sendMail(mailOptions);
};

module.exports = {
  sendVerificationEmail,
}