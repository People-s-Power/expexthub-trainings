const express = require('express');
const assessmentControllers = require('../controllers/accessmentController.js');
const authenticate = require('../middlewares/auth.js');
const accessmentRouter = express.Router();




//Assessment (test and survey) route
accessmentRouter.post("/aptitude-test/:userId", assessmentControllers.aptitudeTest);
accessmentRouter.post("/survey/:userId", assessmentControllers.survey);

//create assessment questions
accessmentRouter.post("/create-assessment", assessmentControllers.createAssessmentQuestions);
// fetch assessment questions
accessmentRouter.get("/get-assessment-questions", assessmentControllers.getAssessmentQuestions);

accessmentRouter.put("/assign/:id", assessmentControllers.assignAssesment)
accessmentRouter.get("/my-assessment/:id", assessmentControllers.getAssignedAssesment)
accessmentRouter.put("/edit/:id", assessmentControllers.editAssesment)
accessmentRouter.get("/single/:id", assessmentControllers.getSingleAssesment)
// The calling student's own result. Authenticated, unlike the rest of these
// routes: /single/:id returns every student's response, so a student-facing
// page must not read from it.
accessmentRouter.get("/my-result/:assessmentId", authenticate, assessmentControllers.getMyResult)
// for submitting user's assessment answers
accessmentRouter.post("/submit-assessment/:id", assessmentControllers.submitAssessment);
accessmentRouter.post("/set-score", assessmentControllers.updateScore);


accessmentRouter.delete("/delete/:id", assessmentControllers.deleteAssesment)










module.exports = accessmentRouter;
