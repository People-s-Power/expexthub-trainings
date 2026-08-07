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
        const { role = "student", link } = decodedState;

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
      } = req.body;

      if (!userType || !fullname || !email || !password || !state) {
        return res.status(400).json({ message: "Please fill all required fields" });
      }

      const lowercasedUserType = userType.toLowerCase();
      const role = determineRole(lowercasedUserType);

      const alreadyExistingUser = await User.findOne({
        email: email.toLowerCase(),
      });

      if (alreadyExistingUser) {
        return res.status(400).json({ message: "User already registered" });
      }

      // Generate a unique verification code per user
      const verificationCode = generateVerificationCode();

      const hashPassword = bcrypt.hashSync(password, 10);
      const newUser = new User({
        username: email.toLowerCase(),
        email: email.toLowerCase(),
        fullname,
        phone,
        country,
        state,
        address,
        role,
        verificationCode,
        verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
        verificationCodeSentAt: new Date(),
        verificationAttempts: 0,
        contact,
        password: hashPassword,
      });

      await newUser.save();

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
      if (!user || !user.email || user.isVerified) return res.json(genericResponse);

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

      // Generate a fresh verification code per request
      const verificationCode = generateVerificationCode();

      await sendVerificationEmail(user.email, verificationCode);
      user.verificationCode = verificationCode;
      // Reset codes share the verification field, so they share its lifecycle too —
      // otherwise a reset code would linger as a permanently valid email-verification
      // code long after the reset was done with.
      user.verificationCodeExpiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
      user.verificationCodeSentAt = new Date();
      user.verificationAttempts = 0;
      await user.save();

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
    const user = await User.findOne({
      verificationCode,
    });

    if (!user) {
      return res.status(400).send({
        message: "Invalid OTP code ",
      });
    }

    try {
      const newHash = bcrypt.hashSync(password);
      user.password = newHash;
      user.verificationCode = null;
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

  addTeamMember: async (req, res) => {
    try {
      const { ownerId, tutorId, privileges } = req.body;

      // Check if owner exists and is a tutor
      const owner = await User.findById(ownerId);
      if (!owner) {
        return res.status(404).json({ message: "Owner not found or invalid role" });
      }

      // Check if the tutor exists
      const tutor = await User.findById(tutorId);
      if (!tutor) {
        return res.status(400).json({ message: "Tutor not found" });
      }

      // Ensure teamMembers array exists
      owner.teamMembers = owner.teamMembers || [];
      tutor.teamMembers = tutor.teamMembers || [];

      // Check if the tutor is already added by this owner
      const isAlreadyAdded = owner.teamMembers.some(
        (member) => member?.tutorId?.toString() === tutorId.toString()
      );

      if (isAlreadyAdded) {
        return res.status(400).json({ message: "Tutor has already been added by this owner" });
      }

      // Add the team member to both the tutor's and owner's records
      const newMember = { privileges, ownerId, tutorId };

      owner.teamMembers.push({ ...newMember, status: "pending" });
      tutor.teamMembers.push({ ...newMember, status: "pending" });

      await owner.save();
      await tutor.save();

      await sendTeamInvitation(tutor.email, owner.fullname, tutorId, ownerId, tutor.fullName);


      res.status(201).json({
        success: true,
        message: "Team member added successfully",
      });
    } catch (error) {
      console.error("Error adding team member:", error);
      res.status(500).json({ message: "Unexpected error during team member addition" });
    }
  },

  editPrivileges: async (req, res) => {
    try {
      const { ownerId, tutorId, newPrivileges } = req.body;

      console.log(ownerId, tutorId);

      // Check if the owner exists and is a tutor
      const owner = await User.findById(ownerId);
      if (!owner || owner.role !== 'tutor') {
        return res.status(404).json({ message: "Owner not found or invalid role" });
      }

      // Check if the tutor exists
      const tutor = await User.findById(tutorId);
      if (!tutor) {
        return res.status(400).json({ message: "Tutor not found" });
      }

      // Check if the tutor is a team member of the owner
      const tutorMember = tutor.teamMembers.find(
        (member) => member.ownerId?.toString() === ownerId.toString()
      );
      const ownerMember = owner.teamMembers.find(
        (member) => member.tutorId?.toString() === tutorId.toString()
      );

      if (!tutorMember || !ownerMember) {
        return res.status(404).json({ message: "Team member relationship not found" });
      }

      // Update privileges for both owner and tutor
      tutorMember.privileges = newPrivileges;
      ownerMember.privileges = newPrivileges;

      await tutor.save();
      await owner.save();

      res.status(200).json({
        success: true,
        message: "Privileges updated successfully",
      });
    } catch (error) {
      console.error("Error editing privileges:", error);
      res.status(500).json({ message: "Unexpected error during privilege update" });
    }
  },
};

module.exports = authControllers;
