const express = require('express');
const courseController = require('../controllers/courseController.js');
const authenticate = require('../middlewares/auth.js');
const authorize = require('../middlewares/authorize.js');
const { TUTOR_ROLES, TUTOR_ONLY } = require('../utils/roles.js');
const { validateObjectId } = require('../middlewares/validateRequest.js');
const { generalLimiter } = require('../middlewares/rateLimiter.js');

const courseRouter = express.Router();

courseRouter.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub Course route" })
});

// Public course browsing
courseRouter.put("/category", generalLimiter, courseController.getCourseByCategory);
courseRouter.put("/category/author", generalLimiter, courseController.getAuthorCourse);
courseRouter.get("/author/:userId", generalLimiter, validateObjectId('userId'), courseController.getPlatformCOurses);
courseRouter.get("/all", generalLimiter, courseController.getAllCourses);
courseRouter.get("/live", generalLimiter, courseController.getLive);
courseRouter.get("/single-course/:courseId", generalLimiter, validateObjectId('courseId'), courseController.getCourseById);
courseRouter.get("/all/category", generalLimiter, courseController.getAllCategory);
courseRouter.get("/recommended-courses/:userId", generalLimiter, validateObjectId('userId'), courseController.getRecommendedCourses);

// Zoom signature (authenticated)
courseRouter.post("/get-zoom-signature", authenticate, courseController.getZoomSignature);

// Student enrollment (requires auth + student/client role)
courseRouter.post("/enroll/:courseId", authenticate, authorize('student', 'client'), validateObjectId('courseId'), courseController.enrollCourse);
courseRouter.get("/enrolled-courses/:userId", authenticate, validateObjectId('userId'), courseController.getEnrolledCourses);

// Instructor/admin course management
courseRouter.post("/add-course/:userId", authenticate, authorize(...TUTOR_ONLY), validateObjectId('userId'), courseController.addCourse);
courseRouter.get("/admissions/:courseId", authenticate, authorize(...TUTOR_ONLY), validateObjectId('courseId'), courseController.getEnrolledStudents);
// Enrolling somebody else needs its own endpoint: /enroll deliberately ignores
// any student id in the body so a student cannot enroll another account.
courseRouter.post("/enroll-student/:courseId", authenticate, authorize(...TUTOR_ROLES), validateObjectId('courseId'), courseController.enrollStudentByInstructor);
// Force-release a student's in-flight payment attempt so the tutor can start a
// fresh one without waiting out the checkout reuse window.
courseRouter.post("/enroll-student/:courseId/cancel-attempt", authenticate, authorize(...TUTOR_ROLES), validateObjectId('courseId'), courseController.cancelStudentPaymentAttempt);
courseRouter.post("/assign/:courseId", authenticate, authorize(...TUTOR_ONLY), validateObjectId('courseId'), courseController.assignTutor);
courseRouter.delete("/delete/:id", authenticate, authorize(...TUTOR_ONLY), validateObjectId('id'), courseController.deleteCourse);
courseRouter.put("/edit/:id", authenticate, authorize(...TUTOR_ONLY), validateObjectId('id'), courseController.editCourse);
courseRouter.get("/notify-live/:id", authenticate, authorize(...TUTOR_ONLY), validateObjectId('id'), courseController.notifyLive);
courseRouter.post("/upload/:courseId", authenticate, authorize(...TUTOR_ONLY), validateObjectId('courseId'), courseController.videoUpload);
courseRouter.get("/cloudinary/signed-url", authenticate, authorize(...TUTOR_ONLY), courseController.getSignedURL);
courseRouter.put('/update-status/:courseId', authenticate, authorize(...TUTOR_ONLY), validateObjectId('courseId', 'id'), courseController.updateStatus);

// Admin-only operations
courseRouter.get("/unapproved", authenticate, authorize('admin'), courseController.getUnaproved);
courseRouter.put("/approve/:courseId", authenticate, authorize('admin'), validateObjectId('courseId'), courseController.approveCourse);
courseRouter.get('/renew/:courseId/:id', authenticate, authorize('admin'), validateObjectId('courseId', 'id'), courseController.renewCourse);

// Waiving a fee is the only way to give a free place — the enroll-student flow
// deliberately has no free branch. Tutors are allowed through the role gate
// because it is their own course's revenue they are waiving; team_member is
// admitted because the controller enforces the "Enroll students" privilege, so
// neither a tutor nor a member can grant on a course they do not manage.
courseRouter.post('/give-scholarship/:courseId', authenticate, authorize(...TUTOR_ROLES), validateObjectId('courseId'), courseController.giveScholarship);

module.exports = courseRouter;
