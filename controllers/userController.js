const User = require("../models/user.js");
const { upload } = require("../config/cloudinary.js");
const Notification = require("../models/notifications.js");
const { addCourse } = require("./courseController.js");
const dayjs = require("dayjs");
const Course = require("../models/courses.js");
const CoursePaymentPlan = require("../models/coursePaymentPlans.js");
const { default: mongoose } = require("mongoose");
const { create } = require("../models/category.js");
const { sendEmailReminder } = require("../utils/sendEmailReminder.js");
const { default: axios } = require("axios");
const crypto = require("crypto");
const { hasPaidPlan, planCatalogue, planNameForId } = require("../utils/plans.js");
const { DEACTIVATED_STATUSES } = require("../utils/affiliateStatus.js");
const { LEARNER_ROLES, isLearnerRole } = require("../utils/roles.js");
const { scopeIdOf } = require("../utils/actingOwner.js");
const { ownedCourseFilter, HEX_ID } = require("../utils/courseOwnership.js");
const { evaluateGraduation } = require("../services/graduationService.js");
// The same ceiling the affiliate commission is bounded by. Both carve a share
// out of one payment, so both have to agree on how much of it may leave —
// importing it here rather than restating it is what keeps them agreeing.
const { MAX_SHARE_PERCENT } = require("../utils/revenueShare.js");
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flutterwavePublicKey = process.env.FLUTTERWAVE_PUBLIC_KEY;

// One request can address every recipient in the composer's list, so the cap
// only ever catches a caller scripting the endpoint directly. It exists because
// this endpoint drives a shared mail server: an unbounded batch from one account
// is a deliverability problem for every other account on it.
const MAX_RECIPIENTS_PER_SEND = 500;

/**
 * Escapes a value for interpolation into the mail HTML. Scoped to the metadata
 * the template interpolates — subject, sender name, CTA label and link. The
 * message body is the provider's own markdown, converted by `marked`, and stays
 * as written.
 */
const escapeHtml = (value) => String(value == null ? '' : value).replace(
  /[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])
);

/**
 * Builds the optional call-to-action button from the provider's pair of fields.
 *
 * All-or-nothing: a button with no destination is a dead end for the recipient
 * and a destination with no label renders an empty button, so a partial pair is
 * dropped rather than half-rendered. The link is restricted to http(s) because
 * it is interpolated into markup — that check is what keeps a `javascript:` URL
 * out of an outgoing mail.
 *
 * Returns null when no button should be rendered.
 */
const buildCta = (ctaText, ctaUrl) => {
  const text = typeof ctaText === 'string' ? ctaText.trim() : '';
  const url = typeof ctaUrl === 'string' ? ctaUrl.trim() : '';
  if (!text || !url || !/^https?:\/\/\S+$/i.test(url)) return null;
  return { text, url };
};

const userControllers = {

  // Flutterwave's checkout script runs in the browser, so it needs the public
  // key. Keep the configured value on the API rather than duplicating a key in
  // the web bundle; a public key is intended to be shared with the checkout.
  getFlutterwavePublicKey: (req, res) => {
    if (!flutterwavePublicKey) {
      console.error('FLUTTERWAVE_PUBLIC_KEY is not configured.');
      return res.status(503).json({ message: 'Payment checkout is not configured' });
    }

    return res.status(200).json({ publicKey: flutterwavePublicKey });
  },

  // The premium plans on sale, as the pricing page offers them.
  //
  // The ids come from the API rather than from the page so that the table and
  // the activation map cannot disagree: an id the page offers but
  // `planNameForId` does not know is refused by Flutterwave with "Payment plan
  // does not exist", and one it knows but the page never offers is a plan nobody
  // can buy. There is no 503 branch here as there is above — a catalogue with
  // nothing in it is a truthful answer, and the page says so, whereas a missing
  // public key means no checkout can run at all.
  getPremiumPlans: (req, res) => {
    return res.status(200).json({ plans: planCatalogue() });
  },

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
      // The same strict test the shared ownership rule applies, so a body id it
      // would refuse is reported as a bad request here rather than reaching the
      // rule and surfacing as a 500. `mongoose.Types.ObjectId.isValid` also
      // accepts a 12-character string, which no stored id ever is.
      if (!HEX_ID.test(requested)) {
        return res.status(400).json({ message: 'Invalid user id' });
      }

      // Read the caller from the database rather than trusting the token claims,
      // so a demotion takes effect immediately.
      const caller = await User.findById(callerId).select('role teamMembers').lean();
      if (!caller) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      // Reading someone else's audience is only for an admin or an accepted team
      // member of that provider — a body-supplied id can never widen the scope.
      if (requested !== callerId && caller.role !== 'admin') {
        const isMember = (caller.teamMembers || []).some(
          (entry) => String(entry.ownerId) === requested && entry.status === 'accepted',
        );
        if (!isMember) {
          return res.status(403).json({ message: 'You can only view your own students' });
        }
      }

      // An admin's audience is the whole platform, matching how the payments and
      // admissions views scope (courseScopeFor returns an unfiltered match for
      // admins). Without this an admin saw only courses they personally own,
      // which is normally none — the courses belong to the provider accounts —
      // so the mailing list came back empty for them.
      //
      // Everyone else scopes through utils/courseOwnership, which is the same
      // rule the admissions ledger uses. Writing the ownership condition out here
      // instead is what made the two lists disagree: this used to name both id
      // spellings in a `Course.find` filter, which Mongoose casts back into a
      // single ObjectId, so every course whose owner was stored as a string was
      // silently dropped from the mailing audience and nowhere else.
      const courseFilter = caller.role === 'admin' && requested === callerId
        ? {}
        : await ownedCourseFilter(requested);

      const courses = await Course.find(courseFilter)
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
        // Rows are kept even without an email or while blocked. This used to drop
        // both, which made the mailing audience quietly disagree with what the
        // provider sees in Admissions → My Students, where the same student does
        // appear: a student with only a phone number on file, or one who was
        // blocked, was simply missing with nothing to explain it. The row is
        // returned with the reason attached instead, and the caller decides
        // whether it can be mailed.
        if (!student || !student._id) return;
        const key = String(student._id);
        const existing = uniqueUsersMap.get(key);
        if (existing) {
          if (courseTitle && !existing.courses.includes(courseTitle)) existing.courses.push(courseTitle);
          // A student reached through two sources can have the field populated on
          // one path and not the other (an enrollment stub with no email, a
          // populated plan user with one), so never let the emptier row win.
          if (!existing.email && student.email) existing.email = student.email;
          return;
        }
        uniqueUsersMap.set(key, {
          _id: student._id,
          fullname: student.fullname,
          email: student.email || '',
          hasEmail: Boolean(student.email),
          phone: student.phone,
          gender: student.gender,
          age: student.age,
          skillLevel: student.skillLevel,
          country: student.country,
          state: student.state,
          address: student.address,
          profilePicture: student.profilePicture,
          graduate: student.graduate,
          blocked: student.blocked === true,
          contact: student.contact,
          courses: courseTitle ? [courseTitle] : [],
        });
      };

      courses.forEach((course) => {
        (course.enrollments || []).forEach((enrollment) => add(enrollment?.user, course.title));
        (course.enrolledStudents || []).forEach((student) => add(student, course.title));
      });

      // Second source: anyone holding a payment plan on these courses. A student
      // who paid can exist only as a plan when the course's enrollment arrays
      // lagged behind (the drift scripts/backfillEnrollmentDrift.js repairs), and
      // someone who paid is squarely inside a provider's audience. Populated in
      // one query rather than per course, and merged with the map above so a
      // student found by both counts once.
      if (courses.length) {
        const plans = await CoursePaymentPlan.find({
          courseId: { $in: courses.map((course) => course._id) },
          status: { $in: ['pending', 'active', 'overdue', 'completed'] },
        })
          .select('userId courseId')
          .populate({
            path: 'userId',
            select: "profilePicture fullname email phone gender age skillLevel country state address graduate blocked contact",
          })
          .lean();

        const titleByCourse = new Map(courses.map((course) => [String(course._id), course.title]));
        plans.forEach((plan) => add(plan?.userId, titleByCourse.get(String(plan.courseId))));
      }

      // Blocked accounts are returned rather than filtered out — they cannot sign
      // in, so mailing them is sending a campaign nobody can act on, but the
      // provider is the one who blocked them and hiding the row only made the
      // audience look wrong. `blocked` is on the row for the caller to disable.
      const students = Array.from(uniqueUsersMap.values())
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
      const students = await User.find({ _id: { $in: studentIds }, role: { $in: LEARNER_ROLES } });

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
      // Both learner spellings — see LEARNER_ROLES. Filtering on `student` alone
      // hid every self-registered graduate from this list.
      const students = await User.find({ role: { $in: LEARNER_ROLES }, assignedCourse: req.body.course, graduate: true });

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
      // Both learner spellings — see LEARNER_ROLES. This backs the admin
      // "Graduates/Experts" counter, which was undercounting for the same reason.
      const students = await User.find({ role: { $in: LEARNER_ROLES }, graduate: true });

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

  /**
   * Activates a purchased plan.
   *
   * Everything that decides the outcome is read from Flutterwave rather than
   * from the request: the tier comes from the plan id on the *verified*
   * transaction, and the subscription must be one Flutterwave opened for that
   * transaction's customer. The caller only says which account to activate, and
   * that has to be their own.
   *
   * The route is authenticated. This still re-checks that the account in the
   * body is the caller's, because the two checks answer different questions —
   * `auth` establishes *who* is calling, and this one establishes *whose* plan
   * they are allowed to change.
   */
  updateTutorLevel: async (req, res) => {
    try {
      const { id: userId, txId: transactionId } = req.body;

      const callerId = req.user?.id || req.user?._id;
      if (!callerId) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      if (!userId || String(userId) !== String(callerId)) {
        // Premium is an upgrade to one's own account; activating it on someone
        // else's account is account takeover by purchase.
        return res.status(403).json({ message: 'You can only change your own plan' });
      }

      if (!transactionId) {
        return res.status(400).json({ message: 'A transaction id is required' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Step 1: Verify transaction
      const verifyResponse = await axios.get(
        `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
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

      // The tier is the plan on the charge. Reading it from the request body
      // instead — as this did — let a Standard payment activate Enterprise,
      // because nothing tied the posted name to the money that was paid.
      const plan = planNameForId(planId);
      if (!plan) {
        console.error(`Premium activation refused: transaction ${transactionId} is on unrecognised plan id ${planId}`);
        return res.status(400).json({
          message: 'We could not match this payment to a plan. Please contact support with your transaction reference.',
        });
      }

      // The charge has to have been made by this account. The checkout is
      // pre-filled with the signed-in provider's address, so a mismatch means
      // the payment belongs to somebody else — and attaching it here would both
      // hand over a plan that was not bought and block the account it does
      // belong to from activating it.
      if (String(customerEmail).toLowerCase() !== String(user.email || '').toLowerCase()) {
        console.error(`Premium activation refused: transaction ${transactionId} was paid by ${customerEmail} but account ${userId} is ${user.email}`);
        return res.status(403).json({
          message: 'This payment was made with a different email address from the one on your account. Please contact support with your transaction reference.',
        });
      }

      // Step 2: Fetch subscriptions for this customer
      const subscriptionsRes = await axios.get(
        `https://api.flutterwave.com/v3/subscriptions?email=${encodeURIComponent(customerEmail)}`,
        {
          headers: {
            Authorization: `Bearer ${flutterwaveSecretKey}`,
          },
        }
      );

      const subscriptions = subscriptionsRes.data.data || [];

      const matchingSubscription = subscriptions.find(
        (sub) => String(sub.plan) === String(planId) && sub.status === 'active'
      );

      // This exact wording is a contract with the checkout, which retries on
      // this one message: Flutterwave opens the subscription as the charge
      // settles, so the first read back can land a beat early.
      if (!matchingSubscription) {
        return res.status(400).json({ message: 'No matching subscription found' });
      }

      // A subscription backs exactly one account. Moving one that is already in
      // use would silently leave the account holding it unable to renew.
      const claimedBy = await User.findOne({
        flutterwaveSubscriptionId: matchingSubscription.id,
        _id: { $ne: userId },
      }).select('_id');

      if (claimedBy) {
        console.error(`Premium activation refused: subscription ${matchingSubscription.id} is already attached to account ${claimedBy._id}`);
        return res.status(409).json({
          message: 'This subscription is already in use on another account. Please contact support.',
        });
      }

      // Step 3: Update user data
      user.premiumPlan = plan;
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
  /**
   * The identity hash the support chat widget verifies.
   *
   * Chatcloud (a Chatwoot fork) compares the hash the browser sends against the
   * HMAC of the user id under the shared key, which is what makes the identity
   * it displays trustworthy: the widget only gets an id it can verify as ours.
   * The key has to stay server-side, so the hash is computed here rather than in
   * the browser — the placeholder the widget used to send was not a hash of
   * anything and could not have passed.
   *
   * With no key configured this answers a null hash, and the widget omits the
   * field. That leaves the identity unverified, which is what chatcloud already
   * does for an anonymous visitor; a wrong hash is not equivalent, it is a
   * rejection.
   */
  getChatIdentity: async (req, res) => {
    try {
      const secret = process.env.CHATCLOUD_HMAC_KEY;

      if (!secret) {
        return res.status(200).json({ identifier_hash: null });
      }

      const userId = req.user?.id || req.user?._id;
      const identifierHash = crypto
        .createHmac('sha256', secret)
        .update(String(userId))
        .digest('hex');

      return res.status(200).json({ identifier_hash: identifierHash });
    } catch (error) {
      console.error('Error building chat identity hash:', error);
      return res.status(500).json({ message: 'Unexpected error' });
    }
  },

  makeGraduate: async (req, res) => {
    try {
      const { userId: studentId } = req.params;
      // The account being worked in, not the person clicking: a team member
      // acting for a provider graduates the provider's students, so the
      // enrollment below has to be looked for on the provider's courses. When
      // nobody is being acted for this is the caller's own id, unchanged.
      const actorId = scopeIdOf(req);

      const student = await User.findById(studentId);
      if (!student) {
        return res.status(404).json({ message: 'Student not found' });
      }
      // Both learner spellings, not `student` alone. A self-registered student
      // is stored as `client`, and this check was rejecting exactly those — the
      // students a tutor is most likely to be looking at.
      if (!isLearnerRole(student.role)) {
        return res.status(400).json({ message: 'Only students can be marked as graduates' });
      }

      // A tutor may only graduate a student enrolled on one of that tutor's
      // courses. The UI privilege check is not a security boundary.
      //
      // Scoped through the shared ownership rule rather than a `Course.exists`
      // filter naming `instructorId: actorId` directly: that spelling is cast to
      // an ObjectId, so for a course whose owner was stored as a string this
      // returned false and the tutor was refused with "you can only graduate
      // students enrolled on your courses" about a student who is enrolled on
      // exactly that course. The gate that decides whether the request is even
      // looked at cannot be the thing that is wrong.
      if (req.user.role !== 'admin') {
        const hasEnrollment = await Course.exists({
          $and: [
            await ownedCourseFilter(actorId),
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

      // Graduation is what unlocks the certificate, so it is the last gate
      // rather than an honour granted on enrolment: the balance has to be
      // settled and every assessment assigned to the student passed. Checked
      // after the already-graduate branch, so re-clicking on someone who
      // graduated before this rule existed still answers "already a graduate"
      // instead of refusing them.
      const eligibility = await evaluateGraduation({
        studentId,
        actorId,
        isAdmin: req.user.role === 'admin',
      });

      if (!eligibility.eligible) {
        // 409 rather than 400: nothing about the request is malformed — the
        // student is simply not there yet, and the same request will succeed
        // once they are. The message names what is missing because the two
        // shortfalls have completely different fixes.
        return res.status(409).json({
          message: eligibility.message,
          code: 'GRADUATION_REQUIREMENTS',
          unpaidCourses: eligibility.unpaidCourses,
          assessments: eligibility.assessments.outstanding,
        });
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

      // A student belongs to a course, and the privilege is "Block and unblock
      // Students". Without this the endpoint toggles `blocked` on whichever
      // account the path names — another provider, an administrator, a student
      // of somebody else — so one grant is a platform-wide denial of access.
      // The enrollment test is the one makeGraduate uses, for the same reason,
      // and it is what the route's own audience was always assumed to imply —
      // which is why it reads the courses the same way, through the shared
      // ownership rule. Naming `instructorId` here directly would cast it to an
      // ObjectId, and a course whose owner was stored as a string would then look
      // like somebody else's: the tutor refused on their own student.
      if (req.user?.role !== 'admin') {
        const scoperId = scopeIdOf(req);
        const managesStudent = await Course.exists({
          $and: [
            await ownedCourseFilter(scoperId),
            { $or: [{ enrolledStudents: userId }, { 'enrollments.user': userId }] },
          ],
        });
        if (!managesStudent) {
          return res.status(403).json({ message: 'You can only block students enrolled on your courses' });
        }
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
      const userId = req.params.id;

      // Your own signature, or — while working inside a provider's account —
      // that provider's. The id arrives in the path, so without this any caller
      // the route admits could overwrite the signature on any account.
      if (req.user?.role !== 'admin' && String(userId) !== String(scopeIdOf(req))) {
        return res.status(403).json({ message: 'You can only change your own signature' });
      }

      const isUser = await User.findById(userId);

      if (!isUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      const { image } = req.files;
      const cloudFile = await upload(image.tempFilePath);

      isUser.signature = cloudFile.url || isUser.signature;
      await isUser.save();

      // The URL, not the account. Returning the saved document sent the caller
      // the whole user record — including the password hash and any stored
      // Google tokens — in reply to an image upload. Neither caller reads it;
      // both re-fetch the profile afterwards.
      return res.status(200).json({ message: 'Signature updated successfully', signature: isUser.signature });

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

      // A deactivated affiliate is excluded outright rather than returned with a
      // flag: this list is what a provider picks a team member from, and offering
      // an account that cannot sign in or earn would only produce an invitation
      // that fails at the other end. The rule lives here, in the query, so no
      // caller can forget it.
      const users = await User.find({
        ...(actorId ? { _id: { $ne: actorId } } : {}),
        $nor: [
          { role: 'affiliate', 'affiliateProfile.status': { $in: DEACTIVATED_STATUSES } },
        ],
      })
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
      //
      // Who is told what depends on who ended it. A member leaving under their
      // own steam previously produced a notice telling them that *they* had
      // removed themselves, and left the provider with no record that a member
      // had gone — which is how a provider ends up surprised that someone they
      // thought was on their team cannot see their courses any more.
      const leftVoluntarily = isSelfRemoval && !isOwner && !isAdmin;

      await Notification.create({
        title: "Team Member Removal",
        content: leftVoluntarily
          ? `You have left ${owner?.organizationName || owner.fullname}'s team.`
          : `${owner?.organizationName || owner.fullname} has removed you from their team.`,
        userId: tutorId,
      });

      if (leftVoluntarily) {
        await Notification.create({
          title: "Team Member Left",
          content: `${member.fullname} has left your team.`,
          userId: ownerId,
        });
      }

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

      // Who may respond:
      //
      //   signed in  → only the invited member, or an admin. An owner can never
      //                self-accept on the member's behalf.
      //   signed out → only on the legacy GET, whose URL is the capability. That
      //                route exists solely for invitations already sitting in
      //                inboxes and pointing straight at this endpoint; there is no
      //                in-app notification to fall back on for those.
      //
      // Every new surface responds through POST, which the route already guards
      // with `auth`. That matters: without the split, a leaked or prefetched URL
      // would be enough to join someone to a team, and team membership carries
      // real privileges over the provider's account.
      const isLegacyLink = req.method === 'GET';
      const mayRespond = req.user
        ? String(actorId) === String(tutorId) || req.user.role === 'admin'
        : isLegacyLink;

      if (!mayRespond) {
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

      // Already accepted. Repeating the request is not an error — the member may
      // have clicked the email link and then the button in their dashboard, and
      // the two now race — but the provider must not be told twice, and the
      // member must not be handed a second "you have joined" for one invitation.
      const alreadyAccepted = ownerTeamEntry.status === "accepted";
      if (alreadyAccepted) {
        return res.json({ success: true, message: "Invitation already accepted" });
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

      return res.json({ success: true, message: "Invitation accepted successfully" });
    } catch (error) {
      console.error("Error updating invitation status:", error);
      res.status(500).json({ message: "Unexpected error occurred" });
    }
  },

  sendMail: async (req, res) => {
    try {
      const { emails, subject, content, ctaText, ctaUrl } = req.body;

      // Validate required fields
      if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ message: 'Emails array is required and cannot be empty' });
      }

      if (emails.length > MAX_RECIPIENTS_PER_SEND) {
        return res.status(400).json({
          message: `A single send is limited to ${MAX_RECIPIENTS_PER_SEND} recipients. Please split this into smaller batches.`,
        });
      }

      if (!subject || !content) {
        return res.status(400).json({ message: 'Subject and content are required' });
      }

      // The sender is the caller. `senderId` used to arrive in the body and
      // decide both the From name and the Reply-To address, so any caller could
      // send a mail that replies went to an inbox of their choosing.
      const sender = await User.findById(req.user?.id || req.user?._id);
      if (!sender) {
        return res.status(404).json({ message: 'Sender not found' });
      }

      // Paid plans include the email tools; the pricing table on /tutor/plans is
      // the contract. This is the server-side half of the gate the composer
      // applies — without it the endpoint is a free relay for any account with a
      // token, whatever plan it is on.
      //
      // The plan checked is the one belonging to the account the work is done
      // for. A provider delegates this tool with the "Send Email" privilege, and
      // it is the provider's plan paying for it, so testing the member's own
      // plan would refuse precisely the delegation the grant exists to allow.
      // The From address above still belongs to the caller, so nothing about
      // who the mail appears to come from changes.
      const planHolder = req.actingOwner || sender;
      if (!hasPaidPlan(planHolder.premiumPlan)) {
        return res.status(403).json({
          message: 'Sending email requires a Standard or Enterprise plan',
          // Named so the composer can tell this refusal from the role-based 403
          // and open the upgrade path rather than reporting a bare failure.
          code: 'PLAN_REQUIRED',
        });
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

      const cta = buildCta(ctaText, ctaUrl);

      // Email carries two renderings of the same message. The HTML part gets a
      // real button; the plain-text part — the one a text-only client shows —
      // gets the label and the link written out, so the call to action survives
      // wherever the client cannot draw a button.
      const ctaHtml = cta
        ? `
              <div style="text-align: center; margin: 28px 0 24px 0;">
                <a href="${escapeHtml(cta.url)}" target="_blank" rel="noopener noreferrer" style="background-color: #FDC332; color: #1a1a1a; padding: 14px 32px; border-radius: 6px; font-weight: 700; font-size: 16px; text-decoration: none; display: inline-block;">
                  ${escapeHtml(cta.text)}
                </a>
              </div>`
        : '';
      const ctaPlain = cta ? `\n\n${cta.text}: ${cta.url}` : '';

      // Send emails to all recipients
      const emailPromises = emails.map(async (email) => {
        const mailOptions = {
          from: 'trainings@experthubllc.com',
          to: email,
          replyTo: sender.email, // This is the key addition
          subject: fullSubject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
              <h2 style="color: #333; border-bottom: 2px solid #FDC332; padding-bottom: 10px;">${escapeHtml(fullSubject)}</h2>
              <div style="background-color: #f9f9f9; padding: 10px; border-radius: 8px; margin: 20px 0;">
                ${htmlContent}
              </div>${ctaHtml}
              <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
              <p style="color: #666; font-size: 12px; text-align: center;">
                This email was sent by <strong>${escapeHtml(sender.fullname)}</strong> via ExperthubLLC Training Platform.
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
          text: `${plainTextContent}${ctaPlain}\n\n---\nThis email was sent by ${sender.fullname} via ExperthubLLC Training Platform.`
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
  },

  // ---------------------------------------------------------------------------
  // Tutor revenue share
  // ---------------------------------------------------------------------------

  /**
   * The revenue share this provider pays the tutors they assign to their courses.
   *
   * Held on the provider's own account, exactly as `affiliateSettings` is, and
   * read with `scopeIdOf(req)`: a team member acting for the provider reads the
   * provider's terms, and no request can name somebody else's account.
   */
  getTutorRevenueShare: async (req, res) => {
    try {
      const account = await User.findById(scopeIdOf(req)).select('tutorRevenueShare');
      if (!account) return res.status(404).json({ message: 'Account not found' });

      const settings = account.tutorRevenueShare || {};

      return res.json({
        settings: {
          enabled: settings.enabled === true,
          percentage: Number(settings.percentage) || 0,
          updatedAt: settings.updatedAt || null,
        },
        limits: { maxSharePercent: MAX_SHARE_PERCENT },
      });
    } catch (error) {
      console.error('Tutor revenue share read failed:', error);
      return res.status(500).json({ message: 'Could not load your tutor revenue share' });
    }
  },

  /**
   * Saves the share.
   *
   * An out-of-range percentage is refused with its own message rather than
   * clamped. This is what the provider pays their tutors; a figure quietly
   * adjusted behind them is a figure they will believe they set, and the tutor
   * is the one who finds out otherwise.
   */
  updateTutorRevenueShare: async (req, res) => {
    try {
      const account = await User.findById(scopeIdOf(req)).select('tutorRevenueShare');
      if (!account) return res.status(404).json({ message: 'Account not found' });

      const { enabled, percentage } = req.body || {};
      const update = { 'tutorRevenueShare.updatedAt': new Date() };

      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ message: 'Enabled must be true or false' });
        }
        update['tutorRevenueShare.enabled'] = enabled;
      }

      if (percentage !== undefined) {
        const rate = Number(percentage);
        if (!Number.isFinite(rate) || rate < 0) {
          return res.status(400).json({ message: 'The revenue share must be a percentage of 0 or more' });
        }
        if (rate > MAX_SHARE_PERCENT) {
          return res.status(400).json({
            message: `The revenue share cannot exceed ${MAX_SHARE_PERCENT}%`,
          });
        }
        update['tutorRevenueShare.percentage'] = rate;
      }

      // Merged against what is stored, because either field can arrive alone.
      // Switching the share on while the rate sits at 0% is the exact failure
      // this screen exists to prevent — the provider believes their tutors are
      // being paid, and nothing moves.
      const current = account.tutorRevenueShare || {};
      const nextEnabled = update['tutorRevenueShare.enabled'] !== undefined
        ? update['tutorRevenueShare.enabled']
        : current.enabled === true;
      const nextPercentage = update['tutorRevenueShare.percentage'] !== undefined
        ? update['tutorRevenueShare.percentage']
        : Number(current.percentage) || 0;

      if (nextEnabled && nextPercentage <= 0) {
        return res.status(400).json({
          message: 'Enter a revenue share above 0% before switching it on',
        });
      }

      await User.updateOne({ _id: account._id }, { $set: update });

      return res.json({
        message: 'Tutor revenue share saved',
        settings: {
          enabled: nextEnabled,
          percentage: nextPercentage,
          updatedAt: update['tutorRevenueShare.updatedAt'],
        },
      });
    } catch (error) {
      console.error('Tutor revenue share update failed:', error);
      return res.status(500).json({ message: 'Could not save your tutor revenue share' });
    }
  },

};


module.exports = userControllers
