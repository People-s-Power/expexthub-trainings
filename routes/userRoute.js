const express = require('express');
const userControllers = require('../controllers/userController.js');
const userRouter = express.Router();
const auth = require("../middlewares/auth.js");
const authorize = require("../middlewares/authorize.js");
const { validateObjectId } = require('../middlewares/validateRequest.js');


userRouter.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub user route" })
});


//User controllers routes
userRouter.get("/profile/:id", auth, validateObjectId('id'), userControllers.getProfile);
userRouter.post("/premium", userControllers.updateTutorLevel);

userRouter.get("/instructors", auth, authorize('tutor', 'admin'), userControllers.getInstructors);
// Team members (impersonating a provider) also need the student directory to
// enrol students on the provider's courses.
userRouter.get("/students", auth, authorize('tutor', 'admin', 'team_member'), userControllers.getStudents);
userRouter.put("/updateProfile/:id", userControllers.upDateprofile);
userRouter.put("/updateProfilePicture/:id", userControllers.updateProfilePhote);

// get course student and instructors
userRouter.put("/myinstructors", userControllers.getMyInstructors);
userRouter.put("/mystudents", userControllers.getMyStudents);
userRouter.get("/tutorstudents/:id", userControllers.getTutorStudents);

userRouter.put("/mymentees", userControllers.getMyMentees);

userRouter.put("/graduate", userControllers.getGraduates);
userRouter.put("/mygraduate", userControllers.getMyGraduates);

userRouter.put("/block/:userId", auth, authorize('tutor', 'admin'), validateObjectId('userId'), userControllers.block)
userRouter.put("/graduate/:userId", auth, authorize('tutor', 'admin'), validateObjectId('userId'), userControllers.makeGraduate)
userRouter.put("/assign/:userId", auth, authorize('tutor', 'admin'), validateObjectId('userId'), userControllers.addCourse)
userRouter.put("/unassign/:userId", auth, authorize('tutor', 'admin'), validateObjectId('userId'), userControllers.unassignCourse)
userRouter.put("/signature/:id", auth, authorize('tutor', 'admin'), validateObjectId('id'), userControllers.addSignature)

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

userRouter.post('/send-mail', userControllers.sendMail);


module.exports = userRouter;
