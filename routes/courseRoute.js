import express from 'express';
import courseController from '../controllers/courseController.js';
import Course from '../models/courses.js';

const courseRouter = express.Router();



courseRouter.get("/", (req, res)=>{
  res.status(200).json({message:"Welcome to ExpertHub Course route"})
});





//COURSE
courseRouter.post("/add-course/:userId", courseController.addCourse);
courseRouter.get("/category/:category", courseController.getCourseByCategory);
courseRouter.get("/:courseId", courseController.getCourseById);
courseRouter.get("/all", courseController.getAllCourses);
courseRouter.post("/addCourseResources/:courseId", courseController.addCourseResources);
//course enroll route
courseRouter.get("/admissions/:courseId", courseController.getEnrolledStudents);
courseRouter.post("/enroll/:courseId", courseController.enrollCourse);
//get roundom courses
courseRouter.get("/recommended-courses", courseController.getRecommendedCourses);














export default courseRouter;
