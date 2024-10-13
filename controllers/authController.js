const passport = require("passport");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.js");
const {
  generateVerificationCode,
} = require("../utils/verficationCodeGenerator.js");
const { sendVerificationEmail } = require("../utils/nodeMailer.js");
const determineRole = require("../utils/determinUserType.js");
const { default: axios } = require("axios");

const verificationCode = generateVerificationCode();

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
        verificationCode,
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

      await axios.post(`${process.env.PEOPLES_POWER_API}/api/v5/auth/sync`, {
        email,
        name: fullname,
        country,
        state,
        userType,
        password: hashPassword
      });

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
  login: async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }
    console.log(email);

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
      expiresIn: "30m",
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
        profilePicture: user.profilePicture,
      },
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
};

module.exports = authControllers;
