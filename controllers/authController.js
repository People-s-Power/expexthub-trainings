const bcrypt = require("bcryptjs");
const User = require("../models/user.js");
const GoogleStrategy = require("passport-google-oauth20").Strategy
const {
  generateVerificationCode,
} = require("../utils/verficationCodeGenerator.js");
const { sendVerificationEmail } = require("../utils/nodeMailer.js");
const determineRole = require("../utils/determinUserType.js");
// const { default: axios } = require("axios");
const jwt = require('jsonwebtoken');
const { logger } = require("handlebars");
const { sendTeamInvitation } = require("../utils/TeamInviteEmail.js");
const Notification = require("../models/notifications.js");

const verificationCode = generateVerificationCode();



// Configure Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "https://trainings.experthubllc.com/auth/google/callback", // Match exactly what's in Google Console
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

        const decodedState = JSON.parse(Buffer.from(req.query.state, "base64").toString("utf8"));
        const { role = "student", link, } = decodedState;

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

      const lowercasedUserType = userType.toLowerCase();
      const role = determineRole(lowercasedUserType);

      const alreadyExistingUser = await User.findOne({
        email: email.toLowerCase(),
      });

      if (alreadyExistingUser) {
        return res.status(400).json({ message: "User already registered" });
      }

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
        contact,
        password: hashPassword,
      });

      await newUser.save();

      if (role === 'tutor') {
        newUser.organizationName = req.body.organizationName;
        await newUser.save()
      }

      // await axios.post(`${process.env.PEOPLES_POWER_API}/api/v5/auth/sync`, {
      //   email,
      //   name: fullname,
      //   country,
      //   state,  
      //   userType,
      //   password: hashPassword
      // });

      await sendVerificationEmail(newUser.email, verificationCode);
      res.status(200).json({ message: "Verification code sent to email", id: newUser._id });

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
        const decodedState = JSON.parse(Buffer.from(req.query.state, "base64").toString("utf-8"));
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

        if (link) {
          return res.redirect(`https://trainings.experthubllc.com/${redirectUrl}?data=${encodeURIComponent(encodedUserData)}`);
        }

        return res.redirect(`https://trainings.experthubllc.com/auth/login?data=${encodeURIComponent(encodedUserData)}`);
      } catch (error) {
        console.error("Error in Google callback:", error);
        return res.redirect(`${process.env.TRAINING_URL}/auth/login?error=Server Error`);
      }
    })(req, res, next);
  },

  login: async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }
    console.log(email);

    const user = await User.findOne({ email: email.toLowerCase() });
    // console.log(user);

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

      id: user._id, // Use tutorId for team_member
      email: user.email,
      role: user.role,
      emailVerification: user.isVerified,
      profilePicture: user.profilePicture,
    };
    const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "24h",
    });


    res.status(201).json({
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
<<<<<<< HEAD
        isGoogleLinked: user.isGoogleLinked,
=======
        organizationName: user.organizationName
>>>>>>> 0255f070c4c7f28dc757549a6d6f743f2f11af8f
      },
    });

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

  // Verify
  verify: async (req, res) => {
    try {
      const { verifyCode } = req.body;

      const userId = req.params.userId;

      // Query the user database to get the user's role
      const user = await User.findById(userId);
      // Check if the user is authenticated
      // if (!req.isAuthenticated()) {
      //   return res.status(401).json({ message: 'Unauthorized' });
      // }

      // Check if the verification code matches the one in the database
      if (user.verificationCode !== verifyCode) {
        return res.status(400).json({ message: "Invalid verification code" });
      }

      // Update user's verification status
      user.isVerified = true;
      user.verificationCode = null; //clear the code after successful verification
      await user.save();

      // Return information to populate dashboard
      return res.status(201).json({
        message: "Successfully Registered a Student",
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

  forgotPassword: async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).send({
        message: "An account with " + req.body.email + " does not exist!",
      });

    try {
      await sendVerificationEmail(user.email, verificationCode);
      // console.log(verificationCode)
      user.verificationCode = verificationCode;
      await user.save();

      res.json({
        message: "Code sent to " + email,
      });
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ message: "Unexpected error during verification" });
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
      const newMember = { privileges, ownerId, tutorId, status: "pending" };

      owner.teamMembers.push(newMember);
      tutor.teamMembers.push(newMember);

      await owner.save();
      await tutor.save();

      await sendTeamInvitation(tutor.email, owner.organizationName || owner.fullname, tutorId, ownerId, tutor.fullname);

      await Notification.create({
        title: "Team Invitation",
        userId: tutorId,
        content: `${owner.fullname} sent you an invitation to be added as a team member`,
      })

      res.status(201).json({
        success: true,
        message: "Invitation for team member sent successfully!",
      });
    } catch (error) {
      console.error("Error adding team member:", error);
      res.status(500).json({ message: "Unexpected error during team member addition" });
    }
  },

  editPrivileges: async (req, res) => {
    try {
      const { ownerId, tutorId, newPrivileges } = req.body;

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
        (member) => member?.ownerId?.toString() === ownerId.toString()
      );
      const ownerMember = owner.teamMembers.find(
        (member) => member?.tutorId?.toString() === tutorId.toString()
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
