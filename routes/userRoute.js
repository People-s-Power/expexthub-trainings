const express = require('express');
const userControllers = require('../controllers/userController.js');
const userRouter = express.Router();
const auth = require("../middlewares/auth.js");


userRouter.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub user route" })
});


//User controllers routes
userRouter.get("/profile/:id", userControllers.getProfile);
userRouter.post("/premium", userControllers.updateTutorLevel);

userRouter.get("/instructors", userControllers.getInstructors);
userRouter.get("/students", userControllers.getStudents);
userRouter.put("/updateProfile/:id", userControllers.upDateprofile);
userRouter.put("/updateProfilePicture/:id", userControllers.updateProfilePhote);

// get course student and instructors
userRouter.put("/myinstructors", userControllers.getMyInstructors);
userRouter.put("/mystudents", userControllers.getMyStudents);
userRouter.get("/tutorstudents/:id", userControllers.getTutorStudents);

userRouter.put("/mymentees", userControllers.getMyMentees);

userRouter.put("/graduate", userControllers.getGraduates);
userRouter.put("/mygraduate", userControllers.getMyGraduates);

userRouter.put("/block/:userId", userControllers.block)
userRouter.put("/graduate/:userId", userControllers.makeGraduate)
userRouter.put("/assign/:userId", userControllers.addCourse)
userRouter.put("/unassign/:userId", userControllers.unassignCourse)
userRouter.put("/signature/:id", userControllers.addSignature)

userRouter.get('/team/:tutorId', userControllers.getTeamMembers)

userRouter.delete('/team/:tutorId/:ownerId', userControllers.deleteTeamMembers)
userRouter.get('/team/:tutorId/:ownerId/:status', userControllers.updateTeamMemberStatus)


module.exports = userRouter;
