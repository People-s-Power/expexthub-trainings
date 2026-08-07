const express = require('express');
const authControllers = require('../controllers/authController.js');
const authenticate = require('../middlewares/auth.js');
const { validateObjectId } = require('../middlewares/validateRequest.js');
const { createRateLimiter, generalLimiter } = require('../middlewares/rateLimiter.js');
const router = express.Router();

// Six-digit codes are guessable in bulk, so the transport is limited as well as
// the code itself: a handful of sends and a bounded number of submissions per
// window, keyed by account when signed in and by IP otherwise.
const verificationSendLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many verification codes requested. Please wait a few minutes and try again.',
});

const verificationAttemptLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: 'Too many verification attempts. Please wait a few minutes and try again.',
});

router.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub Auth Route" })
});

router.get("/logout", authControllers.logout); // TODO: use less
router.post('/register', authControllers.register);
router.post('/register/sync', authControllers.sync);

router.post('/login', authControllers.login);
router.post('/login-with-token', authControllers.loginWithToken);
router.get("/google", authControllers.loginWithGoogle)
router.get("/google/callback", authControllers.googleCallback)

// Signup-time verification: no session exists yet, so these are public but
// rate-limited and validated against a code that expires and burns out.
router.post('/verify/:userId', verificationAttemptLimiter, validateObjectId('userId'), authControllers.verify);
router.post('/verify/:userId/resend', verificationSendLimiter, validateObjectId('userId'), authControllers.resendSignupVerification);

// In-session verification, used when an action such as payment requires a
// verified email.
router.post('/email-verification/request', authenticate, verificationSendLimiter, authControllers.requestEmailVerification);
router.post('/email-verification/confirm', authenticate, verificationAttemptLimiter, authControllers.confirmEmailVerification);

router.put('/forgot-passowrd', verificationSendLimiter, authControllers.forgotPassword);
router.put('/reset-passowrd', verificationAttemptLimiter, authControllers.resetPassword);
router.post('/add-team', generalLimiter, authControllers.addTeamMember)
router.post('/edit-team', generalLimiter, authControllers.editPrivileges)

module.exports = router;
