const express = require('express');
const userControllers = require('../controllers/userController.js');
const userRouter = express.Router();
const auth = require("../middlewares/auth.js");
const authorize = require("../middlewares/authorize.js");
const { TUTOR_ROLES, TUTOR_ONLY } = require("../utils/roles.js");
const { validateObjectId } = require('../middlewares/validateRequest.js');
const { generalLimiter, mailLimiter, paymentLimiter } = require('../middlewares/rateLimiter.js');


userRouter.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub user route" })
});


//User controllers routes
userRouter.get("/profile/:id", auth, validateObjectId('id'), userControllers.getProfile);
// Activation reads the tier from the verified Flutterwave charge, but the
// account it writes to has to be the caller's — so it needs to know who is
// calling. Each call also hits Flutterwave's verify API, hence the tighter cap.
userRouter.post("/premium", auth, paymentLimiter, userControllers.updateTutorLevel);

// The support chat widget asks for its identity hash. Authenticated, because the
// hash is over the caller's own id — it is never issued for somebody else.
userRouter.get("/chat-identity", auth, userControllers.getChatIdentity);

userRouter.get("/instructors", auth, authorize(...TUTOR_ONLY), userControllers.getInstructors);
// Team members (impersonating a provider) also need the student directory to
// enrol students on the provider's courses.
userRouter.get("/students", auth, authorize(...TUTOR_ROLES), userControllers.getStudents);
// Searchable, capped directory of every account — backs the Users filter in the
// admissions menu. Tutor-and-above only: it exposes names and email addresses.
userRouter.get("/directory", auth, authorize(...TUTOR_ROLES), generalLimiter, userControllers.searchUsers);
userRouter.put("/updateProfile/:id", userControllers.upDateprofile);
userRouter.put("/updateProfilePicture/:id", userControllers.updateProfilePhote);

// get course student and instructors
userRouter.put("/myinstructors", userControllers.getMyInstructors);
// The email-marketing audience. Authenticated: the response is a provider's
// whole student list with contact details, which is not public data.
userRouter.put("/mystudents", auth, userControllers.getMyStudents);
userRouter.get("/tutorstudents/:id", userControllers.getTutorStudents);

userRouter.put("/mymentees", userControllers.getMyMentees);

userRouter.put("/graduate", userControllers.getGraduates);
userRouter.put("/mygraduate", userControllers.getMyGraduates);

userRouter.put("/block/:userId", auth, authorize(...TUTOR_ONLY), validateObjectId('userId'), userControllers.block)
userRouter.put("/graduate/:userId", auth, authorize(...TUTOR_ONLY), validateObjectId('userId'), userControllers.makeGraduate)
// Assigning a course category is self-service: any authenticated user may set
// their own category (e.g. the signup step-3 picker, or the dashboard
// interests modal). The controller verifies the caller may only modify their
// own record, so a tutor cannot silently change another user's interests.
userRouter.put("/assign/:userId", auth, validateObjectId('userId'), userControllers.addCourse)
userRouter.put("/unassign/:userId", auth, validateObjectId('userId'), userControllers.unassignCourse)
userRouter.put("/signature/:id", auth, authorize(...TUTOR_ONLY), validateObjectId('id'), userControllers.addSignature)

// Directory of every user category so a provider can add any category of user
// as a team member.
userRouter.get('/users-by-category', auth, userControllers.getUsersByCategory)

// Any authenticated user may read their own team records (so members of every
// category can see which provider added them). Authorization is enforced inside
// the controllers.
userRouter.get('/team/:tutorId', auth, validateObjectId('tutorId'), userControllers.getTeamMembers)

// Authorization is enforced inside the controller: the owner, an admin, or an
// accepted member with the "Delete team member" privilege may remove a member.
userRouter.delete('/team/:tutorId/:ownerId', auth, validateObjectId('tutorId', 'ownerId'), userControllers.deleteTeamMembers)
// Public on purpose: the accept/reject links in the invitation email carry the
// authorization. The controller accepts anonymous requests but still verifies
// the invitation exists before changing any status.
userRouter.get('/team/:tutorId/:ownerId/:status', validateObjectId('tutorId', 'ownerId'), userControllers.updateTeamMemberStatus)

// The caller is the sender, and the caller's plan is checked in the controller
// before a single message goes out.
userRouter.post('/send-mail', auth, authorize(...TUTOR_ROLES), mailLimiter, userControllers.sendMail);

// Self-service password change from Settings. The controller re-checks the
// current password, so this only ever changes the caller's own credentials.
userRouter.put('/change-password', auth, generalLimiter, userControllers.changePassword);


module.exports = userRouter;
