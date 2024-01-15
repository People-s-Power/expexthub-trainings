import express from 'express';
import userControllers from '../controllers/userController.js';
const userRouter = express.Router();


userRouter.get("/", (req, res)=>{
  res.status(200).json({message:"Welcome to ExpertHub user route"})
});



//User controllers routes
userRouter.get("/profile/:userId", userControllers.getProfile);
userRouter.get("/instructors", userControllers.getInstructors);
userRouter.get("/students", userControllers.getStudents);
userRouter.put("/updateProfile/:userId", userControllers.upDateprofile);



export default userRouter;