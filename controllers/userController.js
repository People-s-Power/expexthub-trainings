const User = require("../models/user.js");
const { upload } = require("../config/cloudinary.js");
const Notification = require("../models/notifications.js");
const { addCourse } = require("./courseController.js");
const dayjs = require("dayjs");
const Course = require("../models/courses.js");
const { default: mongoose } = require("mongoose");
const { create } = require("../models/category.js");
const { sendEmailReminder } = require("../utils/sendEmailReminder.js");
const { default: axios } = require("axios");
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;

const userControllers = {

  // To get user profile
  getProfile: async (req, res) => {
    try {
      const userId = req.params.id;
      // Check if the user exists
      const existingUser = await User.findById(userId);

      if (!existingUser) {
        return res.status(404).json({ message: 'User not found' });
      }


      // Extract relevant profile information
      const userProfile = {
        profilePicture: existingUser.image,
        phone: existingUser.phone,
        email: existingUser.email,
        gender: existingUser.gender,
        age: existingUser.age,
        skillLevel: existingUser.skillLevel,
        country: existingUser.country,
        state: existingUser.state,
        fullName: existingUser.fullname,
        accountNumber: existingUser.accountNumber,
        bankCode: existingUser.bankCode,
        premiumPlanExpires: existingUser.premiumPlanExpires,
        premiumPlan: existingUser.premiumPlan,
        signature: existingUser.signature,
        isGoogleLinked: existingUser.isGoogleLinked,
        gMail: existingUser.gMail,
        isYearly: existingUser.isYearly,
        orgUrl: existingUser.orgUrl




      };

      return res.status(200).json({ message: 'User profile retrieved successfully', user: userProfile });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during profile retrieval' });
    }
  },

  // to add aditional category
  addCourse: async (req, res) => {
    const id = req.params.userId;
    const { course } = req.body;
    const callerId = req.user?.id || req.user?._id;

    try {
      // Self-service guard: an authenticated user may only set their own
      // categories. A tutor/admin may still set a category on a student's
      // behalf (the legacy behaviour), but a random user cannot modify another
      // account's interests.
      const caller = req.user;
      const isSelf = String(callerId) === String(id);
      const isStaff = caller && (caller.role === 'tutor' || caller.role === 'admin');
      if (!isSelf && !isStaff) {
        return res.status(403).json({ message: 'You can only update your own course categories' });
      }

      if (!course || typeof course !== 'string' || !course.trim()) {
        return res.status(400).json({ message: 'Course category is required' });
      }

      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // The value is stored either as the primary assignedCourse (when the
      // account has none yet) or appended to otherCourse. This keeps the
      // signup step-3 picker and the dashboard interests modal consistent:
      // a user with no category gets their first choice as assignedCourse.
      const trimmedCourse = course.trim();
      if (user.otherCourse.includes(trimmedCourse) || user.assignedCourse === trimmedCourse) {
        return res.status(400).json({ message: 'Student is already assigned course' });
      }

      if (!user.assignedCourse) {
        user.assignedCourse = trimmedCourse;
      } else {
        user.otherCourse.push(trimmedCourse);
      }
      await user.save();
      return res.status(200).json({
        message: 'Assigned successfully', user: {
          fullName: user.fullname,
          id: user._id,
          email: user.email,
          role: user.role,
          emailVerification: user.isVerified,
          assignedCourse: user.assignedCourse,
          profilePicture: user.image,
          otherCourse: user.otherCourse,
          accessToken: user.accessToken
        },
      });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }

  },

  unassignCourse: async (req, res) => {
    const id = req.params.userId;
    const { course } = req.body;
    const callerId = req.user?.id || req.user?._id;

    try {
      // Self-service guard: an authenticated user may only remove their own
      // categories; a tutor/admin may still manage a student's interests.
      const caller = req.user;
      const isSelf = String(callerId) === String(id);
      const isStaff = caller && (caller.role === 'tutor' || caller.role === 'admin');
      if (!isSelf && !isStaff) {
        return res.status(403).json({ message: 'You can only update your own course categories' });
      }

      if (!course || typeof course !== 'string' || !course.trim()) {
        return res.status(400).json({ message: 'Course category is required' });
      }

      // Find the user by ID
      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Check if the course exists in `otherCourse` or is the `assignedCourse`
      const courseIndex = user.otherCourse.indexOf(course);
      if (courseIndex === -1 && user.assignedCourse !== course) {
        return res.status(400).json({ message: 'Course not assigned to the user' });
      }

      // Remove from `otherCourse` if found
      if (courseIndex !== -1) {
        user.otherCourse.splice(courseIndex, 1);
      }

      // Remove `assignedCourse` if it matches
      // if (user.assignedCourse === course) {
      //   user.assignedCourse = null;
      // }

      // Save the user data
      await user.save();

      return res.status(200).json({
        message: 'Unassigned successfully', user: {
          fullName: user.fullname,
          id: user._id,
          email: user.email,
          role: user.role,
          emailVerification: user.isVerified,
          assignedCourse: user.assignedCourse,
          profilePicture: user.image,
          otherCourse: user.otherCourse,
          accessToken: user.accessToken
        },
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  },

  //To update user profile
  upDateprofile: async (req, res) => {
    try {
      const userId = req.params.id;

      // Check if the user exists
      const existingUser = await User.findById(userId);
      const assigner = await User.findById(req.body.assignerId);

      if (!existingUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      if (existingUser.assignedCourse !== req.body.course) {
        await Notification.create({
          title: "Course assigned",
          content: `${assigner.fullname} just assigned a course to you on ${req.body.course}`,
          userId: existingUser.id,
        });

      }
      console.log(req.body);

      // Update user profile information
      existingUser.fullname = req.body.fullname || existingUser.fullname;
      existingUser.phone = req.body.phone || existingUser.phone;
      existingUser.gender = req.body.gender || existingUser.gender;
      existingUser.age = req.body.age || existingUser.age;
      existingUser.orgUrl = req.body.orgUrl || existingUser.orgUrl;

      existingUser.skillLevel = req.body.skillLevel || existingUser.skillLevel;
      existingUser.country = req.body.country || existingUser.country;
      existingUser.state = req.body.state || existingUser.state;
      existingUser.address = req.body.address || existingUser.address;
      existingUser.assignedCourse = req.body.course || existingUser.assignedCourse
      existingUser.graduate = req.body.graduate || existingUser.graduate

      // Save the updated user profile
      await existingUser.save();


      return res.status(200).json({ message: 'Profile information updated successfully', user: existingUser });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during profile update' });
    }
  },

  getInstructors: async (req, res) => {
    try {
      // Find all users with the role 'instructor'
      const instructors = await User.find({ role: 'tutor' });

      if (!instructors || instructors.length === 0) {
        return res.status(404).json({ message: 'No instructors found' });
      }

      // Extract relevant instructor information
      const instructorProfiles = instructors.map(instructor => ({
        id: instructor._id,
        fullname: instructor.fullname,
        email: instructor.email,
        phone: instructor.phone,
        gender: instructor.gender,
        age: instructor.age,
        course: instructor.assignedCourse,
        skillLevel: instructor.skillLevel,
        country: instructor.country,
        state: instructor.state,
        address: instructor.address,
        profilePicture: instructor.profilePicture,
        blocked: instructor.blocked,
        premiumPlanExpires: instructor.premiumPlanExpires,
        premiumPlan: instructor.premiumPlan,
      }));

      return res.status(200).json({ message: 'Instructors retrieved successfully', instructors: instructorProfiles });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during instructor retrieval' });
    }
  },

  /**
   * Searchable directory of every account on the platform.
   *
   * Backs the Users filter in the admissions menu. Deliberately not a "return
   * everything" endpoint: the user collection is unbounded, so the query is
   * always capped and the client searches server-side rather than downloading
   * the table to filter it in the browser. With no query it returns the most
   * recently created accounts, so the dropdown is useful before typing.
   */
  searchUsers: async (req, res) => {
    try {
      const term = String(req.query.q || req.query.search || '').trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

      const filter = { blocked: { $ne: true } };

      // Roles are stored lowercase; an unknown value would silently match
      // nothing, so it is simply ignored rather than returning an empty list.
      const role = String(req.query.role || '').trim().toLowerCase();
      if (role && role !== 'all') filter.role = role;

      if (term) {
        // Escape before building the regex: an unescaped search box is a path to
        // a catastrophic-backtracking DoS, and a stray "(" would 500 the route.
        const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(safe, 'i');
        filter.$or = [{ fullname: pattern }, { name: pattern }, { email: pattern }, { organizationName: pattern }];
      }

      const users = await User.find(filter)
        .select('fullname name email role profilePicture image organizationName')
        .sort({ _id: -1 })
        .limit(limit)
        .lean();

      return res.status(200).json({
        users: users.map((user) => ({
          id: user._id,
          fullname: user.fullname || user.name || user.email || 'Unnamed user',
          email: user.email || null,
          role: user.role || 'student',
          organizationName: user.organizationName || null,
          profilePicture: user.profilePicture || user.image || null,
        })),
      });
    } catch (error) {
      console.error('User directory search failed:', error);
      return res.status(500).json({ message: 'Unable to search users' });
    }
  },

  getStudents: async (req, res) => {
    try {
      // Learners register as either `student` or `client` (the signup form posts
      // userType "client" for applicants), so both roles must be returned or the
      // Enrol Student list stays empty while real users exist on the platform.
      // The signed-in caller is excluded — a tutor cannot enrol themselves.
      const actorId = req.user?.id || req.user?._id;
      const filter = { role: { $in: ['student', 'client'] }, blocked: { $ne: true } };
      if (actorId) filter._id = { $ne: actorId };

      // A dropdown picker (Enrol Student, scholarship) only needs enough to
      // search and label a row, so it asks for the compact shape via ?compact=1:
      // three fields instead of ~18. That keeps the query and the JSON payload
      // tiny, which is what lets the picker load almost instantly.
      const compact = req.query.compact === '1' || req.query.fields === 'basic';
      if (compact) {
        const picks = await User.find(filter).select('name fullname email').lean();
        const studentProfiles = picks.map(student => ({
          studentId: student._id,
          fullname: student.name || student.fullname,
          email: student.email,
        }));
        return res.status(200).json({ message: 'Students retrieved successfully', students: studentProfiles });
      }

      // Full shape for the admin admissions table and other rich consumers.
      // Project only the fields those render — without this, Mongo returns whole
      // user documents (surveys, team arrays, schedules, OAuth tokens, the
      // password hash) for every learner on the platform.
      const students = await User.find(filter)
        .select('name fullname email phone gender age skillLevel country state address assignedCourse profilePicture image graduate blocked contact isVerified')
        .lean();

      if (!students || students.length === 0) {
        return res.status(200).json({ message: 'No students found', students: [] });
      }

      // Extract relevant student information
      const studentProfiles = students.map(student => ({
        studentId: student._id,
        fullname: student.name || student.fullname,
        email: student.email,
        phone: student.phone,
        gender: student.gender,
        age: student.age,
        skillLevel: student.skillLevel,
        country: student.country,
        state: student.state,
        address: student.address,
        course: student.assignedCourse,
        // The user model historically writes the avatar to `image` and
        // sometimes `profilePicture`; fall back so cards always render one.
        profilePicture: student.profilePicture || student.image || null,
        graduate: student.graduate,
        blocked: student.blocked,
        contact: student.contact,
        isVerified: student.isVerified === true,
      }));

      return res.status(200).json({ message: 'Students retrieved successfully', students: studentProfiles });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during student retrieval' });
    }
  },

  /**
   * The people a provider may email: every student enrolled on any course they
   * own or are assigned to.
   *
   * Two things kept this list empty in production. Course ownership ids drifted
   * between ObjectId and String, so matching on one form silently dropped
   * courses; both forms are matched now. And a tutor with no courses — or courses
   * with no enrollments yet — got a 404, which the client rendered as a failure
   * rather than as "nobody yet". An empty audience is a valid answer, so it is a
   * 200 with an empty list.
   *
   * `approved` is deliberately not filtered on: a course awaiting approval still
   * has real students who are entitled to hear from their provider.
   */
  getMyStudents: async (req, res) => {
    try {
      const callerId = String(req.user?.id || req.user?._id || '');
      const requested = String(req.body?.id || req.body?.ownerId || callerId || '');
      if (!callerId) {
        return res.status(401).json({ message: 'Authentication required' });
      }
      if (!mongoose.Types.ObjectId.isValid(requested)) {
        return res.status(400).json({ message: 'Invalid user id' });
      }

      // Reading someone else's audience is only for an admin or an accepted team
      // member of that provider — a body-supplied id can never widen the scope.
      if (requested !== callerId && req.user?.role !== 'admin') {
        const actor = await User.findById(callerId).select('teamMembers').lean();
        const isMember = (actor?.teamMembers || []).some(
          (entry) => String(entry.ownerId) === requested && entry.status === 'accepted',
        );
        if (!isMember) {
          return res.status(403).json({ message: 'You can only view your own students' });
        }
      }

      // Match both id forms: prod stores course ownership as strings on some
      // documents and ObjectIds on others, and $in against a single form hides
      // whichever half does not match.
      const idVariants = [requested, new mongoose.Types.ObjectId(requested)];

      const courses = await Course.find({
        $or: [
          { instructorId: { $in: idVariants } },
          { assignedTutors: { $in: idVariants } },
        ],
      })
        .select('title enrollments enrolledStudents')
        .populate({
          path: 'enrollments.user',
          select: "profilePicture fullname email phone gender age skillLevel country state address graduate blocked contact",
        })
        .populate({
          path: 'enrolledStudents',
          select: "profilePicture fullname email phone gender age skillLevel country state address graduate blocked contact",
        })
        .lean();

      const uniqueUsersMap = new Map();
      const add = (student, courseTitle) => {
        if (!student || !student._id || !student.email) return;
        const key = String(student._id);
        const existing = uniqueUsersMap.get(key);
        if (existing) {
          if (courseTitle && !existing.courses.includes(courseTitle)) existing.courses.push(courseTitle);
          return;
        }
        uniqueUsersMap.set(key, {
          _id: student._id,
          fullname: student.fullname,
          email: student.email,
          phone: student.phone,
          gender: student.gender,
          age: student.age,
          skillLevel: student.skillLevel,
          country: student.country,
          state: student.state,
          address: student.address,
          profilePicture: student.profilePicture,
          graduate: student.graduate,
          blocked: student.blocked,
          contact: student.contact,
          courses: courseTitle ? [courseTitle] : [],
        });
      };

      courses.forEach((course) => {
        (course.enrollments || []).forEach((enrollment) => add(enrollment?.user, course.title));
        (course.enrolledStudents || []).forEach((student) => add(student, course.title));
      });

      // Blocked accounts are excluded: they cannot sign in, so mailing them is
      // sending a campaign nobody can act on.
      const students = Array.from(uniqueUsersMap.values())
        .filter((student) => student.blocked !== true)
        .sort((a, b) => String(a.fullname || '').localeCompare(String(b.fullname || '')));

      return res.status(200).json({
        message: 'Students retrieved successfully',
        students,
        courses: courses.length,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during student retrieval' });
    }
  },

  /**
   * Change the signed-in user's password from Settings.
   *
   * Always requires the current password, including for accounts a training
   * provider created with a generated password — the onboarding email hands that
   * password to the account owner, and "I know the current one" is what proves
   * the person at the keyboard is them and not someone on a shared machine.
   *
   * Failures deliberately do not distinguish "wrong password" from anything else
   * beyond what the user needs to correct, and every other session keeps working:
   * revoking tokens here would sign the user out mid-change with no way back.
   */
  changePassword: async (req, res) => {
    try {
      const bcrypt = require('bcryptjs');
      const userId = req.user?.id || req.user?._id;
      if (!userId) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Enter your current password and a new password' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: 'Your new password must be at least 8 characters' });
      }
      if (newPassword === currentPassword) {
        return res.status(400).json({ message: 'Your new password must be different from the current one' });
      }

      const user = await User.findById(userId).select('password email fullname');
      if (!user || !user.password) {
        return res.status(404).json({ message: 'Account not found' });
      }

      const matches = await bcrypt.compare(currentPassword, user.password);
      if (!matches) {
        return res.status(401).json({ message: 'Your current password is incorrect' });
      }

      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();

      return res.status(200).json({ message: 'Password updated' });
    } catch (error) {
      console.error('Change password failed:', error);
      return res.status(500).json({ message: 'Unable to update your password' });
    }
  },

  getMyMentees: async (req, res) => {
    try {
      const tutorId = req.body.tutorId || req.body.id || req.params.id;
      // Find all courses created by this tutor
      const courses = await Course.find({ instructorId: tutorId }).select('_id');
      const courseIds = courses.map(course => course._id);

      // Find all students who are enrolled in any of these courses
      const enrolledStudents = await Course.aggregate([
        { $match: { instructorId: tutorId } },
        { $unwind: '$enrolledStudents' },
        { $group: { _id: '$enrolledStudents' } }
      ]);
      const studentIds = enrolledStudents.map(s => s._id);

      // Get student details
      const students = await User.find({ _id: { $in: studentIds }, role: 'student' });

      if (!students || students.length === 0) {
        return res.status(404).json({ message: 'No enrolled students found for this tutor' });
      }

      // Extract relevant student information
      const studentProfiles = students.map(student => ({
        studentId: student._id,
        fullname: student.fullname,
        email: student.email,
        phone: student.phone,
        gender: student.gender,
        age: student.age,
        skillLevel: student.skillLevel,
        country: student.country,
        state: student.state,
        address: student.address,
        course: student.assignedCourse,
        profilePicture: student.profilePicture,
        graduate: student.graduate,
        isVerified: student.isVerified,
        contact: student.contact
      }));

      return res.status(200).json({ message: 'Enrolled students retrieved successfully', students: studentProfiles });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during student retrieval' });
    }
  },

  getMyGraduates: async (req, res) => {
    try {
      // Find all users with the role 'student'
      const students = await User.find({ role: 'student', assignedCourse: req.body.course, graduate: true });

      if (!students || students.length === 0) {
        return res.status(404).json({ message: 'No students found' });
      }

      // Extract relevant student information
      const studentProfiles = students.map(student => ({
        studentId: student._id,
        fullname: student.fullname,
        email: student.email,
        phone: student.phone,
        gender: student.gender,
        age: student.age,
        skillLevel: student.skillLevel,
        country: student.country,
        state: student.state,
        address: student.address,
        course: student.assignedCourse,
        profilePicture: student.profilePicture,
        graduate: student.graduate,
        isVerified: student.isVerified
      }));

      return res.status(200).json({ message: 'Graduates retrieved successfully', students: studentProfiles });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during student retrieval' });
    }
  },
  getTutorStudents: async (req, res) => {
    try {
      const tutorId = req.params.id

      const students = await Course.aggregate([
        { $match: { instructorId: tutorId } },
        { $unwind: "$enrolledStudents" },
        { $group: { _id: "$enrolledStudents" } },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "studentDetails",
          },
        },
        { $unwind: "$studentDetails" },
        {
          $project: {
            _id: "$studentDetails._id",
            fullname: "$studentDetails.fullname",
            email: "$studentDetails.email",
            profilePicture: "$studentDetails.profilePicture",
            skillLevel: "$studentDetails.skillLevel",
            country: "$studentDetails.country",
          },
        },
      ])

      if (!students || students.length === 0) {
        return res.status(404).json({ message: "No students found for this tutor" })
      }

      return res.status(200).json({
        message: "Students retrieved successfully",
        students: students,
      })
    } catch (error) {
      console.error("Error in getTutorStudents:", error)
      return res.status(500).json({ message: "Unexpected error during student retrieval" })
    }
  },
  getMyInstructors: async (req, res) => {
    try {
      // Find all users with the role 'instructor'
      const instructors = await User.find({ role: 'tutor', assignedCourse: req.body.course });

      if (!instructors || instructors.length === 0) {
        return res.status(404).json({ message: 'No instructors found' });
      }

      // Extract relevant instructor information
      const instructorProfiles = instructors.map(instructor => ({
        id: instructor._id,
        fullname: instructor.fullname,
        email: instructor.email,
        phone: instructor.phone,
        gender: instructor.gender,
        age: instructor.age,
        course: instructor.assignedCourse,
        skillLevel: instructor.skillLevel,
        country: instructor.country,
        state: instructor.state,
        address: instructor.address,
        profilePicture: instructor.profilePicture,
        isVerified: instructor.isVerified
      }));

      return res.status(200).json({ message: 'Instructors retrieved successfully', instructors: instructorProfiles });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during instructor retrieval' });
    }
  },

  getGraduates: async (req, res) => {
    try {
      // Find all users with the role 'student'
      const students = await User.find({ role: 'student', graduate: true });

      if (!students || students.length === 0) {
        return res.status(404).json({ message: 'No students found' });
      }

      // Extract relevant student information
      const studentProfiles = students.map(student => ({
        studentId: student._id,
        fullname: student.fullname,
        email: student.email,
        phone: student.phone,
        gender: student.gender,
        age: student.age,
        skillLevel: student.skillLevel,
        country: student.country,
        state: student.state,
        address: student.address,
        course: student.assignedCourse,
        profilePicture: student.profilePicture,
        graduate: student.graduate,
        isVerified: student.isVerified
      }));

      return res.status(200).json({ message: 'Graduates retrieved successfully', students: studentProfiles });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during student retrieval' });
    }

  },

  updateProfilePhote: async (req, res) => {
    try {
      const userId = req.params.id;

      const isUser = await User.findById(userId);

      if (!isUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      const { image } = req.files;

      console.log(image);

      const cloudFile = await upload(image.tempFilePath);

      isUser.profilePicture = cloudFile || isUser.profilePicture;
      isUser.image = cloudFile || isUser.profilePicture;


      await isUser.save();

      return res.status(200).json({ message: 'Profile information updated successfully', user: isUser });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error' });
    }
  },
  updateTutorLevel: async (req, res) => {
    try {
      const { id: userId, txId: transactionId, plan } = req.body;

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Step 1: Verify transaction
      const verifyResponse = await axios.get(
        `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
        {
          headers: {
            Authorization: `Bearer ${flutterwaveSecretKey}`,
          },
        }
      );

      const data = verifyResponse.data.data;
      if (!data.status || data.status !== 'successful') {
        return res.status(400).json({ message: 'Transaction not successful' });
      }

      const customerEmail = data.customer?.email;
      const planId = data.plan;

      if (!customerEmail || !planId) {
        return res.status(400).json({ message: 'Missing customer email or plan ID in transaction' });
      }

      // Step 2: Fetch subscriptions for this customer
      const subscriptionsRes = await axios.get(
        `https://api.flutterwave.com/v3/subscriptions?email=${customerEmail}`,
        {
          headers: {
            Authorization: `Bearer ${flutterwaveSecretKey}`,
          },
        }
      );

      const subscriptions = subscriptionsRes.data.data;

      const matchingSubscription = subscriptions.find(
        (sub) => sub.plan === planId && sub.status === 'active'
      );

      if (!matchingSubscription) {
        return res.status(400).json({ message: 'No matching subscription found' });
      }

      // Step 3: Update user data
      user.premiumPlan = plan?.toLowerCase() || 'basic';
      user.flutterwaveSubscriptionId = matchingSubscription.id;

      await user.save();

      return res.status(200).json({
        message: 'Profile information updated successfully',
        user,
      });

    } catch (error) {
      console.error('Update Tutor Error:', error?.response?.data || error.message);
      return res.status(500).json({ message: 'Unexpected error' });
    }
  },
  makeGraduate: async (req, res) => {
    try {
      const { userId: studentId } = req.params;
      const actorId = req.user?.id || req.user?._id;

      const student = await User.findById(studentId);
      if (!student) {
        return res.status(404).json({ message: 'Student not found' });
      }
      if (student.role !== 'student') {
        return res.status(400).json({ message: 'Only students can be marked as graduates' });
      }

      // A tutor may only graduate a student enrolled on one of that tutor's
      // courses. The UI privilege check is not a security boundary.
      if (req.user.role !== 'admin') {
        const hasEnrollment = await Course.exists({
          $and: [
            {
              $or: [
                { instructorId: actorId },
                { assignedTutors: actorId },
              ],
            },
            {
              $or: [
                { enrolledStudents: studentId },
                { 'enrollments.user': studentId },
              ],
            },
          ],
        });

        if (!hasEnrollment) {
          return res.status(403).json({ message: 'You can only graduate students enrolled on your courses' });
        }
      }

      if (student.graduate === true) {
        return res.status(200).json({ message: 'Student is already a graduate', alreadyGraduated: true });
      }

      student.graduate = true;
      await student.save();
      await Notification.create({
        title: "User Graduated",
        content: `Congratulations you've been made a graduate. Proceed to your profile to download your certificate.`,
        userId: studentId,
      });

      return res.status(200).json({ message: 'User made a graduate successfully' });
    } catch (error) {
      console.error('Error making student graduate:', error);
      return res.status(500).json({ message: 'Unexpected error while making student a graduate' });
    }
  },

  block: async (req, res) => {
    const userId = req.params.userId;
    try {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      user.blocked = !user.blocked;
      await user.save();
      return res.status(200).json({ message: 'User Blocked successfully' });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during user retrieval' });
    }
  },

  addSignature: async (req, res) => {
    try {
      const userId = req.params.id
      const isUser = await User.findById(userId);

      if (!isUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      const { image } = req.files;
      const cloudFile = await upload(image.tempFilePath);

      isUser.signature = cloudFile.url || isUser.signature;
      await isUser.save();

      return res.status(200).json({ message: 'Signature updated successfully', user: isUser });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error' });
    }
  },

  // Fetch a directory of users across every category (role) so a provider can
  // add any category of user as a team member. The current user is excluded.
  getUsersByCategory: async (req, res) => {
    try {
      const actorId = req.user?.id || req.user?._id;

      const users = await User.find(
        actorId ? { _id: { $ne: actorId } } : {}
      )
        .select('fullname email profilePicture role organizationName blocked')
        .lean();

      // Group by role so the client can present a category filter while keeping
      // a single flat list for searching.
      const categories = {};
      users.forEach((user) => {
        const role = user.role || 'student';
        if (!categories[role]) categories[role] = [];
        categories[role].push(user);
      });

      return res.status(200).json({
        success: true,
        users,
        categories,
      });
    } catch (error) {
      console.error('Error fetching users by category:', error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  },

  getTeamMembers: async (req, res) => {
    try {
      const { tutorId } = req.params;
      const actorId = req.user?.id || req.user?._id;

      const user = await User.findById(tutorId).lean().populate({
        path: 'teamMembers.tutorId',
        select: 'fullname _id email profilePicture role assignedCourse otherCourse organizationName'
      })
        .populate({
          path: 'teamMembers.ownerId',
          select: 'fullname _id email profilePicture role assignedCourse otherCourse organizationName'
        });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Any authenticated user may read their own team records so that members
      // of every category can see which provider added them as a team member.
      // An accepted member acting on behalf of the provider (the sidebar
      // "Training Provider" impersonation flow) may also view that provider's
      // team. Only the owner of a team may manage it (edit/delete), enforced in
      // deleteTeamMembers.
      if (actorId && String(actorId) !== String(tutorId) && req.user?.role !== 'admin') {
        const actor = await User.findById(actorId);
        const isAcceptedMemberOfTeam = Array.isArray(actor?.teamMembers)
          ? actor.teamMembers.some(
              (entry) =>
                String(entry.ownerId) === String(tutorId) &&
                entry.status === 'accepted'
            )
          : false;
        if (!isAcceptedMemberOfTeam) {
          return res.status(403).json({ message: 'You can only view your own team records' });
        }
      }

      // Ensure each team member has a status field and expose memberRole.
      const teamMembersWithStatus = Array.isArray(user.teamMembers)
        ? user.teamMembers.map(member => {
            const memberObj = member.toObject ? member.toObject() : member;
            return {
              ...memberObj,
              status: memberObj.status || 'pending', // fallback to 'pending' if missing
              // The member's category, stored at invitation time. Fall back to
              // the member document's role for legacy records.
              memberRole: memberObj.memberRole || memberObj.tutorId?.role || 'tutor',
            };
          })
        : [];

      return res.status(200).json({
        success: true,
        teamMembers: teamMembersWithStatus,
      });
    } catch (error) {
      console.error('Error fetching team members:', error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  },

  deleteTeamMembers: async (req, res) => {
    try {
      const { tutorId, ownerId } = req.params;
      const actorId = req.user?.id || req.user?._id;

      // `tutorId` is the invited member (any category), `ownerId` is the
      // provider that owns the team. Names kept for backward compatibility.
      const member = await User.findById(tutorId).populate("teamMembers");
      const owner = await User.findById(ownerId).populate("teamMembers");

      if (!member) {
        return res.status(404).json({ message: "Member not found" });
      }

      if (!owner) {
        return res.status(404).json({ message: "Owner not found" });
      }

      // Authorization: the provider that owns the team (or an admin) may remove
      // a member. A team member acting on the provider's behalf may also remove
      // members when their privileges grant "Delete team member". In addition,
      // the invited member may remove THEMSELVES from the team at any time — no
      // privilege is required to leave, and the member's own id is the gate so
      // nobody can leave on another member's behalf.
      const isSelfRemoval = String(actorId) === String(tutorId);
      const isOwner = String(actorId) === String(ownerId);
      const isAdmin = req.user?.role === 'admin';
      if (!isAdmin && !isOwner && !isSelfRemoval) {
        const actor = await User.findById(actorId);
        const actorEntry = actor?.teamMembers?.find(
          (entry) =>
            String(entry.ownerId) === String(ownerId) && entry.status === 'accepted'
        );
        const canDelete = actorEntry?.privileges?.some(
          (p) => p.value === 'Delete team member' && p.checked
        );
        if (!canDelete) {
          return res.status(403).json({ message: "You can only remove members from your own team, or leave a team you belong to" });
        }
      }

      // Ensure teamMembers exists before checking its content
      if (!Array.isArray(member.teamMembers) || !Array.isArray(owner.teamMembers)) {
        return res.status(404).json({ message: "Team member data is missing or invalid" });
      }

      // Check if the team relationship exists in both member and owner
      const teamMemberInMember = member.teamMembers.some((entry) =>
        entry?.ownerId?.toString() === ownerId.toString()
      );

      const teamMemberInOwner = owner.teamMembers.some((entry) =>
        entry?.tutorId?.toString() === tutorId.toString()
      );

      if (!teamMemberInMember || !teamMemberInOwner) {
        return res.status(404).json({
          message: "Team member not found in either member or owner teamMembers list",
        });
      }

      // Remove the relationship from both member and owner
      member.teamMembers = member.teamMembers.filter(
        (entry) => entry?.ownerId?.toString() !== ownerId.toString()
      );

      owner.teamMembers = owner.teamMembers.filter(
        (entry) => entry?.tutorId?.toString() !== tutorId.toString()
      );

      await member.save();
      await owner.save();

      // Send email notification
      try {
        await sendEmailReminder(
          member.email,
          `You have been removed from ${owner?.organizationName || owner.fullname}'s team`,
          "Team Member Removal"
        );
      } catch (mailError) {
        console.error("Team removal email failed:", mailError);
      }

      // Create a notification
      await Notification.create({
        title: "Team Member Removal",
        content: `${owner?.organizationName || owner.fullname} has removed you from their team.`,
        userId: tutorId,
      });

      return res.status(200).json({
        success: true,
        message: "Team member successfully deleted from both member and owner",
      });
    } catch (error) {
      console.error("Error deleting team member:", error);
      return res.status(500).json({ message: "Unexpected error occurred!" });
    }
  },

  updateTeamMemberStatus: async (req, res) => {
    try {
      const { tutorId, ownerId, status } = req.params;
      const actorId = req.user?.id || req.user?._id;

      if (!["accepted", "rejected"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      // `tutorId` is the invited member (any category), `ownerId` is the
      // provider that owns the team. Names kept for backward compatibility.
      const member = await User.findById(tutorId);
      if (!member) {
        return res.status(400).json({ message: "Member not found" });
      }

      const owner = await User.findById(ownerId);
      if (!owner) {
        return res.status(404).json({ message: "Owner not found" });
      }

      // The accept/reject links inside the invitation email are themselves the
      // bearer of authorization, so anonymous requests (no JWT) are allowed.
      // When authenticated, only the invited member (or an admin) may respond;
      // owners cannot self-accept on the member's behalf.
      if (req.user && req.user.role !== 'admin' && String(actorId) !== String(tutorId)) {
        return res.status(403).json({ message: "You can only respond to your own team invitation" });
      }

      if (status === "rejected") {
        // Remove from both users' teamMembers arrays
        member.teamMembers = member.teamMembers.filter(
          (entry) => entry?.ownerId?.toString() !== ownerId
        );

        owner.teamMembers = owner.teamMembers.filter(
          (entry) => entry?.tutorId?.toString() !== tutorId
        );

        await owner.save();
        await member.save();

        await Notification.create({
          title: "Team Invitation Rejected",
          userId: ownerId,
          content: `${member.fullname} has rejected your team invitation`,
        });

        return res.json({ success: true, message: "Invitation rejected and removed" });
      }

      // If accepted, just update the status
      let memberTeamEntry = member.teamMembers.find(
        (entry) => entry?.ownerId?.toString() === ownerId.toString()
      );

      let ownerTeamEntry = owner.teamMembers.find(
        (entry) => entry?.tutorId?.toString() === tutorId.toString()
      );

      if (!memberTeamEntry || !ownerTeamEntry) {
        return res.status(400).json({ message: "No invitation found" });
      }

      memberTeamEntry.status = "accepted";
      ownerTeamEntry.status = "accepted";

      await member.save();
      await owner.save();

      await Notification.create({
        title: "Team Invitation Accepted",
        userId: ownerId,
        content: `${member.fullname} has accepted your team invitation`,
      });

      res.json({ success: true, message: "Invitation accepted successfully" });
    } catch (error) {
      console.error("Error updating invitation status:", error);
      res.status(500).json({ message: "Unexpected error occurred" });
    }
  },

  sendMail: async (req, res) => {
    try {
      const { emails, subject, content, senderId } = req.body;

      // Validate required fields
      if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ message: 'Emails array is required and cannot be empty' });
      }

      if (!subject || !content || !senderId) {
        return res.status(400).json({ message: 'Subject, content, and senderId are required' });
      }

      // Get sender information
      const sender = await User.findById(senderId);
      if (!sender) {
        return res.status(404).json({ message: 'Sender not found' });
      }

      // Configure nodemailer transporter
      const nodemailer = require('nodemailer');
      const marked = require('marked');

      const transporter = nodemailer.createTransport({
        host: 'mail.privateemail.com',
        port: 465,
        auth: {
          user: 'trainings@experthubllc.com',
          pass: process.env.NOTIFICATION_EMAIL_PASSWORD,
        },
      });

      // Convert markdown content to HTML
      const htmlContent = marked.parse(content);

      // Create plain text version by stripping HTML tags
      const plainTextContent = content.replace(/[#*`_~\[\]()]/g, '').replace(/\n/g, ' ');

      // Append sender name to subject
      const fullSubject = `${subject} - From ${sender.fullname}`;

      // Send emails to all recipients
      const emailPromises = emails.map(async (email) => {
        const mailOptions = {
          from: 'trainings@experthubllc.com',
          to: email,
          replyTo: sender.email, // This is the key addition
          subject: fullSubject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
              <h2 style="color: #333; border-bottom: 2px solid #FDC332; padding-bottom: 10px;">${fullSubject}</h2>
              <div style="background-color: #f9f9f9; padding: 10px; border-radius: 8px; margin: 20px 0;">
                ${htmlContent}
              </div>
              <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
              <p style="color: #666; font-size: 12px; text-align: center;">
                This email was sent by <strong>${sender.fullname}</strong> via ExperthubLLC Training Platform.
              </p>
            </div>
            <style>
              /* Email-safe CSS for markdown elements */
              h1, h2, h3, h4, h5, h6 { color: #333; margin: 15px 0 10px 0; }
              p { margin: 10px 0; }
              ul, ol { margin: 10px 0; padding-left: 20px; }
              li { margin: 5px 0; }
              blockquote { 
                border-left: 4px solid #ddd; 
                margin: 15px 0; 
                padding-left: 15px; 
                color: #666; 
                font-style: italic; 
              }
              code { 
                background-color: #f4f4f4; 
                padding: 2px 4px; 
                border-radius: 3px; 
                font-family: monospace; 
              }
              pre { 
                background-color: #f4f4f4; 
                padding: 10px; 
                border-radius: 5px; 
                overflow-x: auto; 
              }
              a { color: #007bff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              strong { color: #333; }
              em { color: #555; }
            </style>
          `,
          text: `${plainTextContent}\n\n---\nThis email was sent by ${sender.fullname} via ExperthubLLC Training Platform.`
        };

        try {
          await transporter.sendMail(mailOptions);
          console.log(`Email sent successfully to ${email}`);
          return { email, status: 'success' };
        } catch (error) {
          console.error(`Error sending email to ${email}:`, error);
          return { email, status: 'failed', error: error.message };
        }
      });

      // Wait for all emails to be processed
      const results = await Promise.all(emailPromises);

      // Count successful and failed emails
      const successful = results.filter(result => result.status === 'success');
      const failed = results.filter(result => result.status === 'failed');

      return res.status(200).json({
        message: 'Email sending completed',
        summary: {
          total: emails.length,
          successful: successful.length,
          failed: failed.length
        },
        results: results
      });

    } catch (error) {
      console.error('Error in sendMail:', error);
      return res.status(500).json({ message: 'Unexpected error during email sending' });
    }
  }

};


module.exports = userControllers