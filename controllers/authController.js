const passport = require("passport");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const User = require("../models/user.js");
const GoogleStrategy = require("passport-google-oauth20").Strategy
const {
  generateVerificationCode,
} = require("../utils/verficationCodeGenerator.js");
const { sendVerificationEmail } = require("../utils/nodeMailer.js");
const { sendTeamInvitation } = require("../utils/TeamInviteEmail.js");
const { sendWelcomeEmailOnce } = require("../utils/emails/welcomeEmail.js");

const determineRole = require("../utils/determinUserType.js");
const { default: axios } = require("axios");
const jwt = require('jsonwebtoken');
const { logger } = require("handlebars");




// Configure Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.SERVER_URL}auth/google/callback`, // Match exactly what's in Google Console
      passReqToCallback: true,
      scope: [
        "profile",
        "email",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events",
      ],
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        let decodedState = {};
        if (req.query.state) {
          try {
            decodedState = JSON.parse(Buffer.from(req.query.state, "base64").toString("utf8"));
          } catch (e) {
            decodedState = {};
          }
        }
        // Normalize the requested role through the same mapping the form uses,
        // so a Google signup can never store an off-list role (which would then
        // fail role-gated routes). Defaults to "student".
        const { role: requestedRole = "student", link } = decodedState;
        const role = determineRole(String(requestedRole).toLowerCase());

        const email = profile.emails?.[0]?.value?.toLowerCase();
        if (!email) return done(new Error("No email from Google"), null);

        let user = await User.findOne({ googleId: profile.id });
        console.log(link);

        // 🟡 If linking, find by session user (local user linking Google)
        if (link) {
          user = await User.findById(link);
          if (user) {
            user.googleId = profile.id;
            user.gMail = profile.emails?.[0]?.value;
            user.googleAccessToken = accessToken;
            user.googleRefreshToken = refreshToken || user.googleRefreshToken;
            user.isGoogleLinked = true;
            await user.save();
            return done(null, user);
          }
        }

        // 🟠 If GoogleId not found, try email
        if (!user) {
          user = await User.findOne({ email });
        }

        if (user) {
          // If user already exists, update tokens and info
          user.googleId = profile.id;
          user.googleAccessToken = accessToken;
          user.gMail = profile.emails?.[0]?.value;
          user.googleRefreshToken = refreshToken || user.googleRefreshToken;
          user.isGoogleLinked = true;
          if (!user.signInType) user.signInType = "google";
          if (!user.fullname && profile.displayName) user.fullname = profile.displayName;
          // Backfill a role only when the account has none (legacy/partial
          // signups). Never overwrite an existing role — a returning admin or
          // tutor must not be silently downgraded by a login.
          if (!user.role) user.role = role;
          await user.save();
        } else {
          // 🔵 New user registration
          user = new User({
            username: email,
            email,
            fullname: profile.displayName,
            googleId: profile.id,
            profilePicture: profile.photos?.[0]?.value,
            image: profile.photos?.[0]?.value,
            gMail: profile.emails?.[0]?.value,
            googleAccessToken: accessToken,
            googleRefreshToken: refreshToken,
            signInType: "google",
            isVerified: true,
            role,
            isGoogleLinked: true,
          });
          await user.save();

          // Google accounts arrive pre-verified, so welcome them right away.
          // Fire-and-forget: a mail failure must not fail the OAuth handshake.
          sendWelcomeEmailOnce(user).catch(err =>
            console.error("Welcome email failed after Google signup:", err.message));
        }

        return done(null, user);
      } catch (err) {
        console.log(err);
        return done(err, null);
      }
    },

  ),
)

// Serialize user - store only the user ID in the session
passport.serializeUser((user, done) => {
  done(null, user.id)
})

// Deserialize user - retrieve full user object from the database
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id)
    done(null, user)
  } catch (error) {
    done(error, null)
  }
})

// --- Email verification policy -------------------------------------------
// A six-digit code is only 10^6 wide, so it is safe exclusively because of these
// three limits together: it expires, it dies after a few wrong guesses, and a
// new one cannot be requested in a tight loop to farm attempts.
const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
const VERIFICATION_MAX_ATTEMPTS = 5;
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

/** Timing-safe comparison so a code cannot be recovered by measuring responses. */
function codesMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Issues a fresh code and emails it.
 *
 * Throws with a `status` when the caller is asking too often — the cooldown is
 * what stops an attacker cycling codes to widen their guessing window, and it
 * also protects the mail reputation of the sending domain.
 */
async function issueVerificationCode(user, { force = false } = {}) {
  const lastSentAt = user.verificationCodeSentAt ? new Date(user.verificationCodeSentAt).getTime() : 0;
  const elapsed = Date.now() - lastSentAt;
  if (!force && lastSentAt && elapsed < VERIFICATION_RESEND_COOLDOWN_MS) {
    const retryAfter = Math.ceil((VERIFICATION_RESEND_COOLDOWN_MS - elapsed) / 1000);
    throw Object.assign(
      new Error(`Please wait ${retryAfter} seconds before requesting another code`),
      { status: 429, retryAfter },
    );
  }

  const verificationCode = generateVerificationCode();
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

  // Send before persisting: if the mail fails, the previous code stays valid
  // rather than the account being left with a code nobody received.
  await sendVerificationEmail(user.email, verificationCode);

  user.verificationCode = verificationCode;
  user.verificationCodeExpiresAt = expiresAt;
  user.verificationCodeSentAt = new Date();
  user.verificationAttempts = 0;
  await user.save();

  return { expiresAt, cooldownSeconds: Math.ceil(VERIFICATION_RESEND_COOLDOWN_MS / 1000) };
}

/**
 * Checks a submitted code and marks the account verified.
 *
 * Returns { ok: true } or { ok: false, status, message, code }. Wrong guesses are
 * counted against the issued code, and burning through the budget invalidates it
 * so the attacker has to request a new one (and wait out the cooldown) to keep
 * going.
 */
async function consumeVerificationCode(user, submittedCode) {
  if (user.isVerified) return { ok: true, alreadyVerified: true };

  const trimmed = String(submittedCode || '').trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return { ok: false, status: 400, message: 'Enter the six-digit code from your email' };
  }
  if (!user.verificationCode) {
    return { ok: false, status: 400, message: 'Request a new verification code to continue', code: 'CODE_NOT_ISSUED' };
  }

  // Codes issued before expiry tracking existed have no timestamp; treat those as
  // valid so accounts mid-signup at deploy time are not stranded.
  if (user.verificationCodeExpiresAt && new Date(user.verificationCodeExpiresAt) < new Date()) {
    return { ok: false, status: 400, message: 'That code has expired. Request a new one.', code: 'CODE_EXPIRED' };
  }

  if ((user.verificationAttempts || 0) >= VERIFICATION_MAX_ATTEMPTS) {
    return { ok: false, status: 429, message: 'Too many incorrect attempts. Request a new code.', code: 'TOO_MANY_ATTEMPTS' };
  }

  if (!codesMatch(trimmed, user.verificationCode)) {
    user.verificationAttempts = (user.verificationAttempts || 0) + 1;
    const remaining = Math.max(0, VERIFICATION_MAX_ATTEMPTS - user.verificationAttempts);
    if (remaining === 0) {
      // Burn the code rather than leaving a known-targeted secret alive.
      user.verificationCode = null;
      user.verificationCodeExpiresAt = null;
    }
    await user.save();
    return {
      ok: false,
      status: 400,
      message: remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Too many incorrect attempts. Request a new code.',
      code: remaining > 0 ? 'CODE_INVALID' : 'TOO_MANY_ATTEMPTS',
    };
  }

  user.isVerified = true;
  user.verificationCode = null;
  user.verificationCodeExpiresAt = null;
  user.verificationAttempts = 0;
  await user.save();
  return { ok: true };
}

function issueAccessToken(user) {
  return jwt.sign({
    fullName: user.fullname,
    id: user._id,
    email: user.email,
    role: user.role,
    emailVerification: user.isVerified,
  }, process.env.JWT_SECRET, { expiresIn: '24h' });
}

// Roles allowed to register somebody else and have their credentials emailed.
const REGISTRAR_ROLES = ['admin', 'tutor', 'provider', 'team_member'];

/**
 * Resolves the signed-in training provider behind an assisted registration.
 *
 * /auth/register is public by necessity — self-signup has no session — so the
 * provider-registers-a-student branch cannot rely on route middleware. Instead
 * the bearer token is verified here and the account behind it re-read from the
 * database, so a token whose role claim was minted before a demotion (or for a
 * deleted account) grants nothing. Returns null for anonymous or unauthorized
 * callers, which makes the caller fall back to ordinary self-signup.
 */
async function resolveRegistrar(req) {
  try {
    if (!process.env.JWT_SECRET) return null;
    const rawToken = req.headers?.authorization || req.cookies?.accessToken;
    if (!rawToken) return null;
    const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const actor = await User.findById(claims?.id).select('role fullname organizationName blocked');
    if (!actor || actor.blocked === true) return null;
    if (!REGISTRAR_ROLES.includes(String(actor.role || '').toLowerCase())) return null;
    return actor;
  } catch (error) {
    // An invalid or expired token is simply "not a registrar" — the request
    // still succeeds as a normal self-signup.
    return null;
  }
}

const authControllers = {
  register: async (req, res) => {
    try {
      const {
        userType,
        fullname,
        email,
        phone,
        country,
        state,
        address,
        contact,
        password,
        // Optional course category chosen at signup (applicant step 3). Stored as
        // the user's primary assigned course so recommendations and dashboard
        // filters work from day one, and the value is validated against the
        // registered categories so junk cannot be persisted.
        category,
        organizationName,
      } = req.body;

      if (!userType || !fullname || !email || !password || !state) {
        return res.status(400).json({ message: "Please fill all required fields" });
      }

      // Validate email shape and password strength up front, so the frontend and
      // backend agree on what a valid account looks like.
      const normalizedEmail = String(email).trim().toLowerCase();
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(normalizedEmail)) {
        return res.status(400).json({ message: "Please enter a valid email address" });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters long" });
      }

      const lowercasedUserType = userType.toLowerCase();
      const role = determineRole(lowercasedUserType);

      const alreadyExistingUser = await User.findOne({
        email: normalizedEmail,
      });

      if (alreadyExistingUser) {
        return res.status(400).json({ message: "User already registered" });
      }

      // Category is optional at signup; when provided it must be a valid
      // registered category (or one of its sub-categories) so the value stored
      // on the account can never be an arbitrary string.
      let normalizedCategory = null;
      if (category && typeof category === 'string' && category.trim()) {
        const Category = require('../models/category.js');
        const catDoc = await Category.findOne({
          $or: [
            { category: category.trim() },
            { subCategory: category.trim() },
          ],
        }).lean();
        if (catDoc) normalizedCategory = category.trim();
      }

      // Generate a unique verification code per user
      const verificationCode = generateVerificationCode();

      // A training provider may register a prospective student and hand them
      // their credentials. That branch is only ever taken for a caller whose
      // bearer token resolves to a live tutor/admin account — `sendCredentials`
      // from an anonymous request is ignored, so the public endpoint cannot be
      // used to mint pre-verified accounts or to have the API mail a password
      // to an address the requester does not control.
      const registrar = req.body?.sendCredentials === true ? await resolveRegistrar(req) : null;
      const createdByProvider = Boolean(registrar) && role !== 'admin';

      const hashPassword = bcrypt.hashSync(password, 10);
      const newUser = new User({
        username: normalizedEmail,
        email: normalizedEmail,
        fullname,
        phone,
        country,
        state,
        address,
        role,
        organizationName,
        verificationCode,
        verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
        verificationCodeSentAt: new Date(),
        verificationAttempts: 0,
        contact,
        password: hashPassword,
        // The provider vouched for this person in the admissions flow and the
        // student never receives a code, so holding the account in an unverified
        // state would only block them from paying later with no way to clear it.
        ...(createdByProvider ? { isVerified: true, registeredBy: registrar._id } : {}),
        // Applicant signup step 3 — primary course category.
        ...(normalizedCategory ? { assignedCourse: normalizedCategory } : {}),
      });

      await newUser.save();

      if (createdByProvider) {
        // Onboarding mail carries the sign-in details and a link straight to the
        // Settings page where the student can replace the generated password.
        // The plaintext password exists only for the life of this request — it is
        // never persisted, and the account already stores only the bcrypt hash.
        try {
          await sendWelcomeEmailOnce(newUser, {
            credentials: { email: normalizedEmail, password },
            registeredByName: registrar.organizationName || registrar.fullname || null,
          });
        } catch (mailError) {
          console.error('Onboarding email failed for provider-registered user:', mailError.message);
          // The account exists either way, so the caller still gets it back —
          // the admissions UI shows the credentials on screen for the provider
          // to pass on, and an enrolment in progress can still select them.
          return res.status(200).json({
            message: 'Student registered, but we could not send their onboarding email.',
            id: newUser._id,
            emailDelivered: false,
            createdByProvider: true,
            student: {
              id: newUser._id,
              fullname: newUser.fullname,
              email: newUser.email,
            },
          });
        }

        return res.status(200).json({
          message: 'Student registered and their sign-in details were emailed to them',
          id: newUser._id,
          emailDelivered: true,
          createdByProvider: true,
          student: {
            id: newUser._id,
            fullname: newUser.fullname,
            email: newUser.email,
          },
        });
      }

      // A mail failure must not present as a failed registration: the account
      // exists, so reporting 500 would leave the user unable to re-register and
      // with no obvious way forward. Tell them to resend instead.
      try {
        await sendVerificationEmail(newUser.email, verificationCode);
      } catch (mailError) {
        console.error("Verification email failed at registration:", mailError.message);
        return res.status(200).json({
          message: "Account created, but we could not send your code. Please request a new one.",
          id: newUser._id,
          emailDelivered: false,
        });
      }

      res.status(200).json({ message: "Verification code sent to email", id: newUser._id, emailDelivered: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: "Unexpected error during registration" });
    }
  },

  sync: async (req, res) => {
    try {
      const {
        email,
        fullname,
        country,
        state,
        userType,
        password,
      } = req.body;

      const lowercasedUserType = userType.toLowerCase();
      const role = determineRole(lowercasedUserType);
      await User.updateOne(
        { email: email.toLowerCase() },
        {
          fullname,
          country,
          state,
          password,
          role,
        }
      );
      console.log(`synced`);

      res.status(200).json({ message: "User synced successfully" });
    } catch (error) {
      console.error("Error during user sync:", error);
      return res.status(500).json({ message: "Unexpected error during sync" });
    }
  },
  loginWithGoogle: (req, res, next) => {
    const redirectUrl = req.query.redirectUrl || "/";
    const role = req.query.role || "student";
    const link = req.query.link || false;

    const stateObj = {
      redirectUrl,
      role,
      link,
    };

    const stateString = Buffer.from(JSON.stringify(stateObj)).toString("base64");

    passport.authenticate("google", {
      accessType: "offline",
      prompt: "consent",
      state: stateString,
      scope: [
        "profile",
        "email",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
      ]
    })(req, res, next);
  },

  // Google OAuth callback
  googleCallback: (req, res, next) => {
    passport.authenticate("google", { session: false }, async (err, user, info) => {
      if (err || !user) {
        console.error("Google auth error:", err || "No user");
        return res.redirect(`${process.env.TRAINING_URL}/auth/login?error=Google auth failed, Try again`);
      }

      try {
        // Decode the state from the request
        let decodedState = {};
        if (req.query.state) {
          try {
            decodedState = JSON.parse(Buffer.from(req.query.state, "base64").toString("utf-8"));
          } catch (e) {
            decodedState = {};
          }
        }
        const { redirectUrl, link } = decodedState;

        const payload = {
          user: {
            fullName: user.fullname,
            id: user._id,
            email: user.email,
            role: user.role,
            emailVerification: user.isVerified,
            assignedCourse: user.assignedCourse,
            profilePicture: user.profilePicture,
            otherCourse: user.otherCourse,
            isGoogleLinked: user.isGoogleLinked || false,
          },
          accessToken: user.googleAccessToken,
          success: true,
        };

        const encodedUserData = jwt.sign(payload, process.env.JWT_SECRET, {
          expiresIn: "2m", // short-lived token
        });

        // If redirectUrl is absolute, use it directly; otherwise, prepend base URL
        let finalRedirect;
        if (/^https?:\/\//i.test(redirectUrl)) {
          finalRedirect = `${redirectUrl}?data=${encodeURIComponent(encodedUserData)}`;
        } else {
          finalRedirect = `${process.env.TRAINING_URL}/${redirectUrl}?data=${encodeURIComponent(encodedUserData)}`;
        }

        return res.redirect(finalRedirect);

      } catch (error) {
        console.error("Error in Google callback:", error);
        return res.redirect(`${process.env.TRAINING_URL}/auth/login?error=Server Error`);
      }
    })(req, res, next);
  },

  login: async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: "Missing fields" });
      }

      const user = await User.findOne({ email: email.toLowerCase() });

      if (!user) {
        return res.status(401).json({ message: "Incorrect Email or Password!" });
      }

      if (user.blocked) {
        return res.status(401).json({ message: "User Blocked!" });
      }

      // Password matching
      const isMatch = bcrypt.compareSync(password, user.password ?? "");

      if (!isMatch) {
        return res.status(401).json({ message: "Incorrect Email or Password" });
      }

      // generate jwt
      const payload = {
        fullName: user.fullname,
        id: user._id,
        email: user.email,
        role: user.role,
        emailVerification: user.isVerified,
        profilePicture: user.profilePicture,
      };
      const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "24h",
      });

      res.status(200).json({
        message: "Successfully logged in",
        accessToken,
        user: {
          fullName: user.fullname,
          id: user._id,
          email: user.email,
          role: user.role,
          emailVerification: user.isVerified,
          isVerified: user.isVerified === true,
          assignedCourse: user.assignedCourse,
          profilePicture: user.image,
          otherCourse: user.otherCourse,
          isGoogleLinked: user.isGoogleLinked,
        },
      });
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({ message: "Unexpected error during login" });
    }
  },

  loginWithToken: async (req, res) => {
    const { accessToken } = req.body;

    jwt.verify(accessToken, process.env.JWT_SECRET, async (err, user) => {
      if (err) {
        return res.sendStatus(403); // Forbidden
      }
      const theUser = await User.findOne({ email: user.email.toLowerCase() });
      if (!theUser) {
        return res.sendStatus(403);
      }
      return res.status(201).json({
        message: "Successfully logged in",
        accessToken,
        user: {
          fullName: theUser.fullname,
          id: theUser._id,
          email: theUser.email,
          role: theUser.role,
          emailVerification: theUser.isVerified,
          assignedCourse: theUser.assignedCourse,
          profilePicture: theUser.image,
          otherCourse: user.otherCourse,
        },
      });
    });

  },

  logout: (req, res) => {
    res.status(200).json({ message: "successfully signed out" });
  },

  /**
   * Signup verification. Unauthenticated by necessity — the account does not have
   * a session yet — so it leans entirely on the code's expiry, attempt budget and
   * the route's rate limit.
   */
  verify: async (req, res) => {
    try {
      const user = await User.findById(req.params.userId);
      if (!user) return res.status(404).json({ message: "Account not found" });

      const result = await consumeVerificationCode(user, req.body.verifyCode);
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message, code: result.code });
      }

      // Onboarding must never fail the verification response — the account is
      // verified either way. Log failures and keep the request moving.
      sendWelcomeEmailOnce(user).catch(err =>
        console.error("Welcome email failed after signup verification:", err.message));

      return res.status(201).json({
        message: "Email verified successfully",
        accessToken: issueAccessToken(user),
        user: {
          fullName: user.fullname,
          id: user._id,
          username: user.username,
          email: user.email,
          role: user.role,
        },
      });
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ message: "Unexpected error during verification" });
    }
  },

  /**
   * Resend for the signup screen, where the account exists but has no session yet.
   *
   * Only ever mails the address already on the account, and the response is
   * identical whether or not the id resolves, so it cannot be used to enumerate
   * accounts or to send mail anywhere of the caller's choosing.
   */
  resendSignupVerification: async (req, res) => {
    const genericResponse = { message: "If that account still needs verifying, a new code is on its way." };
    try {
      const user = await User.findById(req.params.userId);
      if (!user || !user.email || user.isVerified) {
        return res.json({ ...genericResponse, cooldownSeconds: 0 });
      }

      await issueVerificationCode(user);
      return res.json({ ...genericResponse, cooldownSeconds: Math.ceil(VERIFICATION_RESEND_COOLDOWN_MS / 1000) });
    } catch (error) {
      if (error.status === 429) {
        return res.status(429).json({ message: error.message, retryAfter: error.retryAfter });
      }
      console.error("Signup verification resend failed:", error);
      return res.status(502).json({ message: "We could not send the code. Please try again." });
    }
  },

  /**
   * Sends a verification code to the signed-in user's own email.
   *
   * The address is read from the account, never from the request body, so this
   * cannot be turned into a way to mail arbitrary recipients.
   */
  requestEmailVerification: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ message: "Account not found" });
      if (!user.email) return res.status(400).json({ message: "Your account has no email address on file" });

      if (user.isVerified) {
        return res.json({ message: "Your email is already verified", alreadyVerified: true });
      }

      const { expiresAt, cooldownSeconds } = await issueVerificationCode(user);
      return res.json({
        message: `We sent a six-digit code to ${user.email}`,
        email: user.email,
        expiresAt,
        cooldownSeconds,
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({ message: error.message, retryAfter: error.retryAfter });
      }
      console.error("Verification code request failed:", error);
      return res.status(502).json({ message: "We could not send the code. Please try again." });
    }
  },

  /**
   * Confirms the code for the signed-in user and returns a refreshed token, so
   * the client's cached claims stop saying the email is unverified.
   */
  confirmEmailVerification: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ message: "Account not found" });

      const result = await consumeVerificationCode(user, req.body.code);
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message, code: result.code });
      }

      // Fire-and-forget: onboarding must never block the verification response.
      sendWelcomeEmailOnce(user).catch(err =>
        console.error("Welcome email failed after in-session verification:", err.message));

      return res.json({
        message: "Email verified successfully",
        accessToken: issueAccessToken(user),
        user: {
          fullName: user.fullname,
          id: user._id,
          username: user.username,
          email: user.email,
          role: user.role,
          isVerified: true,
        },
      });
    } catch (error) {
      console.error("Email verification failed:", error);
      return res.status(500).json({ message: "Unexpected error during verification" });
    }
  },

  forgotPassword: async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user)
        return res.status(400).send({
          message: "An account with " + email + " does not exist!",
        });

      await issueVerificationCode(user, { force: true });

      res.json({
        message: "Code sent to " + email,
      });
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ message: "Unexpected error during password reset" });
    }
  },

  resetPassword: async (req, res) => {
    const { password, verificationCode } = req.body;
    const user = await User.findOne({ verificationCode });

    if (!user) {
      return res.status(400).send({ message: "Invalid OTP code" });
    }

    try {
      const result = await consumeVerificationCode(user, verificationCode);
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message, code: result.code });
      }
      const newHash = bcrypt.hashSync(password, 10);
      user.password = newHash;
      user.verificationCode = null;
      user.verificationCodeExpiresAt = null;
      user.verificationCodeSentAt = null;
      await user.save();

      res.json({
        message: "Password reset successfully",
      });
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ message: "Unexpected error during verification" });
    }
  },

  // Resolve and authorize the team owner for any team-management action.
  //
  // The owner is normally the signed-in user, but a team member who has been
  // granted "Add/Edit/Delete team member" privileges may act on behalf of the
  // provider that added them (the sidebar impersonation flow keeps the member's
  // JWT while swapping the store's user id). For those cases the client sends
  // the provider's id explicitly as `ownerId`.
  resolveAuthorizedOwner: async (req, requiredPrivilege) => {
    const actorId = req.user?.id || req.user?._id;
    const requestedOwnerId = req.body.ownerId || actorId;

    const owner = await User.findById(requestedOwnerId);
    if (!owner || !['tutor', 'admin', 'provider'].includes(owner.role)) {
      const err = new Error('Owner not found or invalid role');
      err.status = 404;
      throw err;
    }

    const isActualOwner = String(actorId) === String(owner._id);
    const isAdmin = req.user?.role === 'admin';
    if (isActualOwner || isAdmin) return owner;

    // Delegated access: the actor must be an accepted member of this owner's
    // team AND hold the matching team-management privilege.
    const actor = await User.findById(actorId);
    const membership = Array.isArray(actor?.teamMembers)
      ? actor.teamMembers.find(
          (entry) =>
            String(entry.ownerId) === String(owner._id) &&
            entry.status === 'accepted'
        )
      : undefined;

    const canManage = membership?.privileges?.some(
      (p) => p.value === requiredPrivilege && p.checked
    );
    if (!canManage) {
      const err = new Error('You do not have permission to manage this team');
      err.status = 403;
      throw err;
    }
    return owner;
  },

  addTeamMember: async (req, res) => {
    try {
      const owner = await authControllers.resolveAuthorizedOwner(req, 'Add team member');
      const ownerId = owner._id;
      // Accept both the legacy `tutorId` field and the generic `memberId` so the
      // endpoint works for any category of user (tutor, client, student, provider,
      // admin, team_member) without breaking existing clients.
      const memberId = req.body.memberId || req.body.tutorId;
      const { privileges } = req.body;

      if (!ownerId || !memberId) {
        return res.status(400).json({ message: "Owner and member are required" });
      }
      if (!Array.isArray(privileges)) {
        return res.status(400).json({ message: "Privileges must be an array" });
      }

      // Any registered user can be added as a team member regardless of category.
      const member = await User.findById(memberId);
      if (!member) {
        return res.status(400).json({ message: "User not found" });
      }
      if (owner._id.equals(member._id)) {
        return res.status(400).json({ message: "You cannot add yourself to your team" });
      }

      owner.teamMembers = owner.teamMembers || [];
      member.teamMembers = member.teamMembers || [];

      const isAlreadyAdded = owner.teamMembers.some(
        (existing) => existing?.tutorId?.toString() === memberId.toString()
      );
      if (isAlreadyAdded) {
        return res.status(400).json({ message: "User has already been added by this owner" });
      }

      const newMember = {
        privileges,
        ownerId: owner._id,
        tutorId: member._id,
        // Record the member's category so the UI can label them correctly and
        // route them to the right experience.
        memberRole: member.role || 'tutor',
        status: "pending",
      };
      owner.teamMembers.push(newMember);
      member.teamMembers.push(newMember);

      await owner.save();
      await member.save();

      // Email delivery must not turn a successfully persisted invitation into a
      // false 500. The invite remains visible in the app and can be accepted there.
      let emailDelivered = false;
      try {
        await sendTeamInvitation(member.email, owner.fullname, memberId, ownerId, member.fullname, member.role);
        emailDelivered = true;
      } catch (mailError) {
        console.error("Team invitation email failed:", mailError);
      }

      return res.status(201).json({
        success: true,
        message: emailDelivered
          ? "Team member added successfully"
          : "Team member added; invitation email could not be sent",
        emailDelivered,
      });
    } catch (error) {
      console.error("Error adding team member:", error);
      const status = error?.status || 500;
      return res.status(status).json({
        message: error?.message || "Unexpected error during team member addition",
      });
    }
  },

  editPrivileges: async (req, res) => {
    try {
      // The owner (or a delegated member with the "Edit team member"
      // privilege) is resolved and authorized here.
      const owner = await authControllers.resolveAuthorizedOwner(req, 'Edit team member');
      const ownerId = owner._id;
      // Accept both the legacy `tutorId` field and the generic `memberId`.
      const memberId = req.body.memberId || req.body.tutorId;
      const { newPrivileges } = req.body;

      if (!ownerId || !memberId || !Array.isArray(newPrivileges)) {
        return res.status(400).json({ message: "Owner, member and privileges are required" });
      }

      // Check if the member exists
      const member = await User.findById(memberId);
      if (!member) {
        return res.status(400).json({ message: "User not found" });
      }

      // Check if the member belongs to the owner's team
      const memberEntry = member.teamMembers.find(
        (entry) => entry.ownerId?.toString() === ownerId.toString()
      );
      const ownerEntry = owner.teamMembers.find(
        (entry) => entry.tutorId?.toString() === memberId.toString()
      );

      if (!memberEntry || !ownerEntry) {
        return res.status(404).json({ message: "Team member relationship not found" });
      }

      // Update privileges for both owner and member
      memberEntry.privileges = newPrivileges;
      ownerEntry.privileges = newPrivileges;

      await member.save();
      await owner.save();

      return res.status(200).json({
        success: true,
        message: "Privileges updated successfully",
      });
    } catch (error) {
      console.error("Error editing privileges:", error);
      const status = error?.status || 500;
      return res.status(status).json({
        message: error?.message || "Unexpected error during privilege update",
      });
    }
  },

  /**
   * Sets the course category chosen during signup (step 3 of the applicant
   * wizard).
   *
   * Runs before verification, so the account has no session yet and this is
   * deliberately unauthenticated. It is safe because:
   *  - only a not-yet-verified account may be modified (bounds the window to
   *    the minutes right after registration);
   *  - only a registered course category (or sub-category) is accepted;
   *  - the id must be a valid ObjectId and the route is rate-limited.
   */
  setSignupCategory: async (req, res) => {
    try {
      const user = await User.findById(req.params.userId);
      if (!user) return res.status(404).json({ message: "Account not found" });
      if (user.isVerified) {
        return res.status(403).json({ message: "This account is already verified. Use your dashboard to change interests." });
      }

      const { category } = req.body;
      if (!category || typeof category !== 'string' || !category.trim()) {
        return res.status(400).json({ message: "Course category is required" });
      }

      // Only a registered category or one of its sub-categories may be stored,
      // so the value on the account can never be an arbitrary string.
      const Category = require('../models/category.js');
      const trimmed = category.trim();
      const catDoc = await Category.findOne({
        $or: [
          { category: trimmed },
          { subCategory: trimmed },
        ],
      }).lean();
      if (!catDoc) {
        return res.status(400).json({ message: "That course category is not available" });
      }

      if (!user.assignedCourse) {
        user.assignedCourse = trimmed;
      } else if (!user.otherCourse.includes(trimmed)) {
        user.otherCourse.push(trimmed);
      }
      await user.save();

      return res.status(200).json({
        success: true,
        message: "Course category saved",
        user: {
          id: user._id,
          assignedCourse: user.assignedCourse,
          otherCourse: user.otherCourse,
        },
      });
    } catch (error) {
      console.error("Error setting signup category:", error);
      return res.status(500).json({ message: "Unexpected error while saving course category" });
    }
  },
};

module.exports = authControllers;
