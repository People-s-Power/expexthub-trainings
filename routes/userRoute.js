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
userRouter.get("/students", auth, authorize('tutor', 'admin'), userControllers.getStudents);
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

userRouter.get('/team/:tutorId', auth, authorize('tutor', 'admin'), validateObjectId('tutorId'), userControllers.getTeamMembers)

userRouter.delete('/team/:tutorId/:ownerId', auth, authorize('tutor', 'admin'), validateObjectId('tutorId', 'ownerId'), userControllers.deleteTeamMembers)
userRouter.get('/team/:tutorId/:ownerId/:status', validateObjectId('tutorId', 'ownerId'), userControllers.updateTeamMemberStatus)

userRouter.post('/send-mail', userControllers.sendMail);


module.exports = userRouter;
