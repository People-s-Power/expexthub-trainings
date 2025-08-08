const express = require('express');
const courseController = require('../controllers/courseController.js');
const Course = require('../models/courses.js');

const courseRouter = express.Router();



courseRouter.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub Course route" })
});





//COURSE
courseRouter.put("/category", courseController.getCourseByCategory);
courseRouter.put("/category/author", courseController.getAuthorCourse);
courseRouter.get("/author/:userId", courseController.getPlatformCOurses);

courseRouter.get("/all", courseController.getAllCourses);
courseRouter.get("/live", courseController.getLive);


courseRouter.post("/get-zoom-signature", courseController.getZoomSignature);
courseRouter.post("/add-course/:userId", courseController.addCourse);
courseRouter.get("/single-course/:courseId", courseController.getCourseById)
// courseRouter.post("/addCourseResources/:courseId", courseController.addCourseResources);
//course enroll route
courseRouter.get("/admissions/:courseId", courseController.getEnrolledStudents);
courseRouter.post("/enroll/:courseId", courseController.enrollCourse);
courseRouter.post("/assign/:courseId", courseController.assignTutor);

courseRouter.get("/enrolled-courses/:userId", courseController.getEnrolledCourses);
//get roundom courses
courseRouter.get("/recommended-courses/:userId", courseController.getRecommendedCourses);

// get all courses with category

courseRouter.get("/all/category", courseController.getAllCategory);
courseRouter.delete("/delete/:id", courseController.deleteCourse)
courseRouter.put("/edit/:id", courseController.editCourse)
courseRouter.get("/notify-live/:id", courseController.notifyLive)

courseRouter.get("/unapproved", courseController.getUnaproved)
courseRouter.put("/approve/:courseId", courseController.approveCourse)

// uplaod video
courseRouter.post("/upload/:courseId", courseController.videoUpload)
courseRouter.get("/cloudinary/signed-url", courseController.getSignedURL)
courseRouter.put('/update-status/:courseId', courseController.updateStatus)
courseRouter.get('/renew/:courseId/:id', courseController.renewCourse)

// Give scholarship to students
courseRouter.post('/give-scholarship/:courseId', courseController.giveScholarship)

module.exports = courseRouter;
