const express = require('express');
const userControllers = require('../controllers/userController.js');
const userRouter = express.Router();
const auth = require("../middlewares/auth.js");
const tutorSurface = require("../middlewares/tutorSurface.js");
const { TUTOR_ROLES, TUTOR_ONLY } = require("../utils/roles.js");
const { validateObjectId } = require('../middlewares/validateRequest.js');
const { generalLimiter, mailLimiter, paymentLimiter } = require('../middlewares/rateLimiter.js');


userRouter.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub user route" })
});


//User controllers routes
userRouter.get("/profile/:id", auth, validateObjectId('id'), userControllers.getProfile);
userRouter.get("/payment-config", auth, generalLimiter, userControllers.getFlutterwavePublicKey);
// The premium catalogue the pricing page renders. Read here rather than typed
// into the page, so the ids on sale are the ids activation recognises.
userRouter.get("/plans", auth, generalLimiter, userControllers.getPremiumPlans);
// Activation reads the tier from the verified Flutterwave charge, but the
// account it writes to has to be the caller's — so it needs to know who is
// calling. Each call also hits Flutterwave's verify API, hence the tighter cap.
userRouter.post("/premium", auth, paymentLimiter, userControllers.updateTutorLevel);

// The support chat widget asks for its identity hash. Authenticated, because the
// hash is over the caller's own id — it is never issued for somebody else.
userRouter.get("/chat-identity", auth, userControllers.getChatIdentity);

userRouter.get("/instructors", auth, tutorSurface(TUTOR_ONLY, 'Assign course to a Tutor'), userControllers.getInstructors);
// Team members (impersonating a provider) also need the student directory to
// enrol students on the provider's courses.
userRouter.get("/students", auth, tutorSurface(TUTOR_ROLES, 'Enroll students'), userControllers.getStudents);
// Searchable, capped directory of every account — backs the Users filter in the
// admissions menu. Tutor-and-above only: it exposes names and email addresses.
userRouter.get("/directory", auth, tutorSurface(TUTOR_ROLES, 'View Course Participant and send email reminder'), generalLimiter, userControllers.searchUsers);
userRouter.put("/updateProfile/:id", userControllers.upDateprofile);
userRouter.put("/updateProfilePicture/:id", userControllers.updateProfilePhote);

// get course student and instructors
userRouter.put("/myinstructors", userControllers.getMyInstructors);
// The email-marketing audience. Authenticated: the response is a provider's
// whole student list with contact details, which is not public data.
userRouter.put("/mystudents", auth, userControllers.getMyStudents);
// The same audience for the provider's tutors — the sibling of /mystudents, so
// it carries the same guard the composer's Send Email action does: a caller
// without the mailing privilege has no use for a recipient list of contact
// details.
userRouter.put(
  "/mytutors",
  auth,
  tutorSurface(TUTOR_ROLES, 'Send Email'),
  userControllers.getMyTutors,
);
userRouter.get("/tutorstudents/:id", userControllers.getTutorStudents);

userRouter.put("/mymentees", userControllers.getMyMentees);

userRouter.put("/graduate", userControllers.getGraduates);
userRouter.put("/mygraduate", userControllers.getMyGraduates);

userRouter.put("/block/:userId", auth, tutorSurface(TUTOR_ONLY, 'Block and unblock Students'), validateObjectId('userId'), userControllers.block)
userRouter.put("/graduate/:userId", auth, tutorSurface(TUTOR_ONLY, 'Make Graduate'), validateObjectId('userId'), userControllers.makeGraduate)
// Assigning a course category is self-service: any authenticated user may set
// their own category (e.g. the signup step-3 picker, or the dashboard
// interests modal). The controller verifies the caller may only modify their
// own record, so a tutor cannot silently change another user's interests.
userRouter.put("/assign/:userId", auth, validateObjectId('userId'), userControllers.addCourse)
userRouter.put("/unassign/:userId", auth, validateObjectId('userId'), userControllers.unassignCourse)
userRouter.put("/signature/:id", auth, tutorSurface(TUTOR_ONLY, 'Edit Signature'), validateObjectId('id'), userControllers.addSignature)

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
// Accept or decline a team invitation.
//
// POST, and this is the path every new surface uses. The GET below was the only
// route for years, and it *changes state on a GET* — which means any mail client
// that prefetches links to scan them (Outlook SafeLinks, most corporate
// antivirus) silently accepted invitations on the member's behalf before they
// ever read the message. A POST cannot be triggered by a link preview.
//
// Authorization is enforced inside the controller.
userRouter.post(
  '/team/:tutorId/:ownerId/:status',
  auth,
  generalLimiter,
  validateObjectId('tutorId', 'ownerId'),
  userControllers.updateTeamMemberStatus
)

// Public on purpose: the accept/reject links in the invitation email carry the
// authorization. The controller accepts anonymous requests but still verifies
// the invitation exists before changing any status.
//
// Kept only so invitations already sitting in inboxes keep working — they point
// straight at this endpoint and have no in-app notification to fall back on.
// New emails link to the frontend page at /team/invitation, which confirms the
// decision before calling the POST route above. Do not build anything new on
// this one.
userRouter.get('/team/:tutorId/:ownerId/:status', validateObjectId('tutorId', 'ownerId'), userControllers.updateTeamMemberStatus)

// The caller is the sender, and the caller's plan is checked in the controller
// before a single message goes out.
userRouter.post('/send-mail', auth, tutorSurface(TUTOR_ROLES, 'Send Email'), mailLimiter, userControllers.sendMail);

// Self-service password change from Settings. The controller re-checks the
// current password, so this only ever changes the caller's own credentials.
userRouter.put('/change-password', auth, generalLimiter, userControllers.changePassword);

// The revenue share the provider pays the tutors they assign. Scoped to the
// caller's own account by the controller, so there is no id in the path — the
// account is always the caller's.
//
// Guarded with the same pair the affiliate commission settings use, and for the
// same reason: no privilege is named, so a team member acting for the provider
// is refused on both. Changing what every tutor is paid is not the same decision
// as assigning one to a course, and it must not ride in on the privilege that
// allows the second.
userRouter.get('/revenue-share', auth, tutorSurface(TUTOR_ROLES), userControllers.getTutorRevenueShare);
userRouter.put('/revenue-share', auth, tutorSurface(TUTOR_ONLY), userControllers.updateTutorRevenueShare);

// What the provider has actually earned across their own courses — the Total
// Earnings card on the dashboard. Reading money, so it is the same "View
// Payments" grant that opens the payment records, and it scopes to the acting
// owner so a delegated member sees the figure for the account they are in.
userRouter.get(
  '/earnings-summary',
  auth,
  tutorSurface(TUTOR_ROLES, 'View Payments'),
  userControllers.getEarningsSummary,
);

// The per-course half of the same setting. Guarded identically: an override on
// one course is the same money decision as the general rate, so it must not be
// reachable through a narrower privilege than the rate it overrides.
userRouter.get('/courses', auth, tutorSurface(TUTOR_ONLY), userControllers.listCourseTutorShares);
userRouter.put(
  '/courses/:courseId/tutor-share',
  auth,
  tutorSurface(TUTOR_ONLY),
  userControllers.updateCourseTutorShare,
);


module.exports = userRouter;
