const User = require("../models/user.js");
const Assessment = require("../models/assessment.js");
const { upload } = require("../config/cloudinary.js");
const Notification = require("../models/notifications.js");
const mongoose = require("mongoose");
const { sendAssessmentAssignedEmail } = require("../utils/emails/assessmentAssignedEmail.js");
const { sendAssessmentScoredEmail } = require("../utils/emails/assessmentScoredEmail.js");
const { sendAssessmentCompletedEmail } = require("../utils/emails/assessmentCompletedEmail.js");

/**
 * Answers used to be stored as three fixed fields on every question. They now
 * live in `options`, an array of any length, so providers can add and remove
 * answer choices. Assessments written before that change still hold their
 * answers in answerA/answerB/answerC and must keep working, so every question is
 * projected onto `options` on the way out rather than migrated in place: no
 * migration script, no downtime, and historical documents are left untouched.
 */
function normalizeQuestion(question) {
  const plain = question?.toObject ? question.toObject() : { ...(question || {}) };
  const legacyOptions = [plain.answerA, plain.answerB, plain.answerC]
    .filter((answer) => answer !== undefined && answer !== null && String(answer) !== '');
  const options = Array.isArray(plain.options) && plain.options.length
    ? plain.options.map((option) => String(option ?? ''))
    : legacyOptions;
  return { ...plain, options };
}

/** Same projection for a whole assessment. Accepts a doc or a lean object. */
function normalizeAssessment(assessment) {
  if (!assessment) return assessment;
  const plain = assessment.toObject ? assessment.toObject() : { ...assessment };
  plain.assesment = Array.isArray(plain.assesment) ? plain.assesment.map(normalizeQuestion) : [];
  return plain;
}

/**
 * Sends an assessment email without ever failing the request it belongs to.
 *
 * Assigning an assessment and recording a score are the real work; the email is
 * a courtesy on top. A misconfigured mailer must not turn a successful grade
 * into a 500, so this mirrors notifyEnrolledStudent in courseController.js:
 * log and carry on.
 */
async function sendAssessmentEmailSafely(label, send) {
  try {
    await send();
  } catch (error) {
    console.error(`${label} email failed:`, error?.message || error);
  }
}

const assessmentControllers = {

  createAssessmentQuestions: async (req, res) => {
    try {
      const assessmentsData = req.body; // Array of assessments

      // const { image } = req.files;
      const cloudFile = await upload(req.body.image);
      assessmentsData.image = cloudFile.url

      // const assessments = assessmentsData.map(({ question, answer1, answer2, answer3, correctAnswerIndex }) => {
      //   const answers = [answer1, answer2, answer3];

      //   if (correctAnswerIndex < 0 || correctAnswerIndex >= answers.length) {
      //     return res.status(400).json({ message: 'Correct answer index is invalid.' });
      //   }

      //   return {
      //     question,
      //     answers,
      //     correctAnswerIndex,
      //   };
      // });

      const newAssessments = await Assessment.create(assessmentsData);
      // await newAssessments.save()


      return res.status(200).json({ message: 'Assessment data saved successfully', assessments: newAssessments });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during assessment processing' });
    }
  },

  //Get route to fetch questions
  getAssessmentQuestions: async (req, res) => {
    try {
      const assessmentQuestions = await Assessment.find();

      return res.status(200).json({ assessmentQuestions: assessmentQuestions.map(normalizeAssessment) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during assessment questions retrieval' });
    }
  },

  getSingleAssesment: async (req, res) => {
    try {
      const id = req.params.id

      const myAssesment = await Assessment.find({ _id: id }).populate({ path: 'responses.student', select: "profilePicture fullname _id" }).lean()

      return res.status(200).json({ message: 'Assesment retrieved successfully', myAssesment: myAssesment.map(normalizeAssessment) });

    } catch (error) {
      console.error(error);
      return res.status(500).json(error);
    }
  },

  /**
   * The calling student's own result for one assessment.
   *
   * getSingleAssesment returns every student's response and the assessment routes
   * carry no auth, so pointing the student-facing result page at it would hand
   * each student their classmates' scores. This endpoint is authenticated and
   * returns only the caller's own response.
   */
  getMyResult: async (req, res) => {
    try {
      const { assessmentId } = req.params;
      const studentId = req.user?.id || req.user?._id;

      if (!mongoose.Types.ObjectId.isValid(assessmentId)) {
        return res.status(400).json({ message: "Invalid assessment ID." });
      }

      const assessment = await Assessment.findById(assessmentId);
      if (!assessment) {
        return res.status(404).json({ message: "Assessment not found." });
      }

      const response = assessment.responses.find(
        (entry) => String(entry.student) === String(studentId)
      );

      if (!response) {
        return res.status(404).json({ message: "You have not taken this assessment." });
      }

      return res.status(200).json({
        message: 'Result retrieved successfully',
        result: {
          assessmentId: String(assessment._id),
          title: assessment.title,
          type: assessment.type,
          image: assessment.image,
          // Absent until a provider grades it. The result page renders that as
          // "awaiting grading" rather than showing a misleading zero.
          score: response.score !== undefined ? response.score : null,
          total: Array.isArray(assessment.assesment) ? assessment.assesment.length : 0,
          answers: response.answers || [],
        },
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during result retrieval' });
    }
  },

  getAssignedAssesment: async (req, res) => {
    try {
      const userId = req.params.id

      const myAssesment = await Assessment.find({ assignedStudents: { _id: userId } });

      return res.status(200).json({ message: 'User assesment retrieved successfully', myAssesment: myAssesment.map(normalizeAssessment) });

    } catch (error) {
      console.error(error);
      return res.status(500).json(error);
    }
  },

  assignAssesment: async (req, res) => {
    try {
      const id = req.params.id

      const { studentId, userId } = req.body

      const myAssesment = await Assessment.findById(id);
      const user = await User.findById(userId);
      const student = await User.findById(studentId);

      if (!myAssesment) {
        return res.status(404).json({ message: 'Assessment not found' });
      }
      if (!student) {
        return res.status(404).json({ message: 'Student not found' });
      }

      // Assigning the same assessment twice used to push a duplicate id and
      // would now also send a second email. Treat it as the no-op it is.
      const alreadyAssigned = (myAssesment.assignedStudents || []).some(
        (assigned) => String(assigned) === String(studentId)
      );
      if (alreadyAssigned) {
        return res.status(200).json({
          message: 'This assessment has already been assigned to this student',
          myAssesment,
        });
      }

      myAssesment.assignedStudents.push(studentId);

      await myAssesment.save();
      await Notification.create({
        title: "Assesmet assigned",
        content: `${user.fullname} sent you an Assessment`,
        contentId: myAssesment.id,
        userId: studentId,
      });

      // The assignment itself is already saved; a mail failure must not undo it.
      await sendAssessmentEmailSafely('Assessment assigned', () =>
        sendAssessmentAssignedEmail({
          student,
          assessment: myAssesment,
          tutor: user,
        })
      );

      return res.status(200).json({ message: 'User assesment Assigned successfully', myAssesment });

    } catch (error) {
      console.error(error);
      return res.status(500).json(error);
    }
  },

  editAssesment: async (req, res) => {
    try {
      // findByIdAndUpdate rather than updateOne: updateOne ignores `new` (so the
      // old code returned a write result, not the assessment) and skips
      // subdocument validators, which is what enforces that the correct answer
      // index points at one of the question's options.
      const assesment = await Assessment.findByIdAndUpdate(
        req.params.id,
        { $set: req.body },
        { new: true, runValidators: true }
      )
      if (!assesment) {
        return res.status(404).json({ message: 'Assessment not found' });
      }
      return res.json(normalizeAssessment(assesment));
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  deleteAssesment: async (req, res) => {
    try {
      const assesment = await Assessment.deleteOne({
        _id: req.params.id
      })
      res.json(assesment);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  submitAssessment: async (req, res) => {
    try {
      const { id } = req.params; // Assessment ID
      const { studentId, answers } = req.body; // Student's ID and their answers

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid assessment ID." });
      }

      const assessment = await Assessment.findById(id);

      if (!assessment) {
        return res.status(404).json({ message: "Assessment not found." });
      }

      // Check if the student has already submitted
      const existingResponse = assessment.responses.find(
        (response) => response.student.toString() === studentId
      );

      if (existingResponse) {
        return res
          .status(400)
          .json({ message: "You have already submitted this assessment." });
      }

      // Add the student's response to the responses array.
      // Each answer carries the id of the question it belongs to, so scoring can
      // still line answers up with questions after a question is deleted from
      // the middle of the assessment. Older clients sent bare strings; keep
      // those working by storing them as answer-only entries.
      const storedAnswers = (Array.isArray(answers) ? answers : []).map((entry) => {
        if (entry === null || entry === undefined) return { answer: '' };
        if (typeof entry === 'object') {
          return {
            answer: entry.answer !== undefined && entry.answer !== null ? String(entry.answer) : '',
            questionId: mongoose.Types.ObjectId.isValid(entry.questionId)
              ? entry.questionId
              : undefined,
          };
        }
        return { answer: String(entry) };
      });

      assessment.responses.push({
        student: studentId,
        answers: storedAnswers,
      });

      // Save the updated assessment
      await assessment.save();

      // The provider and the instructor are told a submission is waiting. Both
      // are resolved from records rather than the request body so a caller
      // cannot redirect the notification: `tutor` is whoever created the
      // assessment, and `registeredBy` is the provider who onboarded the student
      // (set by the admissions flow, absent for self-registered students).
      // Resolved after the save and sent through the safe wrapper — the
      // submission is already durable and a mail failure must not undo it.
      try {
        const student = await User.findById(studentId).select("fullname email registeredBy");

        const [tutor, provider] = await Promise.all([
          assessment.tutor
            ? User.findById(assessment.tutor).select("fullname email role")
            : null,
          student?.registeredBy
            ? User.findById(student.registeredBy).select("fullname email role")
            : null,
        ]);

        const recipients = [tutor, provider].filter(Boolean);

        if (recipients.length) {
          await sendAssessmentEmailSafely('Assessment completed', () =>
            sendAssessmentCompletedEmail({
              assessment,
              student,
              recipients,
            })
          );
        }
      } catch (error) {
        console.error('Assessment completion notification failed:', error?.message || error);
      }

      return res.status(201).json({
        message: "Assessment submitted successfully.",
      });
    } catch (error) {
      console.error("Error submitting assessment:", error);
      return res
        .status(500)
        .json({ message: "An error occurred while submitting the assessment." });
    }
  },

  survey: async (req, res) => {
    try {
      const {
        // computerAccess,
        // internetAccess,
        gender,
        employmentStatus,
        trainingHours,
        age,
        preferedCourse,
        yearsOfExperience,
        currentEducation,
        joiningAccomplishment,
      } = req.body;

      // Get user ID from the request headers
      const userId = req.params.userId;

      // Query the user database to get the user's role
      const foundUser = await User.findById(userId);

      if (foundUser) {
        // Check if the user has already submitted a survey
        // if (foundUser.survey) {
        //   return res.status(400).json({ message: 'Survey already submitted' });
        // }

        // Update the survey data in the user document
        foundUser.survey = {
          // computerAccess,
          // internetAccess,
          gender,
          employmentStatus,
          trainingHours,
          age,
          // Category is chosen once at signup (step 3) and saved to
          // assignedCourse. The survey no longer asks again, so fall back to the
          // already-chosen course instead of recording a blank on the survey.
          preferedCourse: preferedCourse || foundUser.assignedCourse,
          yearsOfExperience,
          currentEducation,
          joiningAccomplishment,
        };

        // Never let an empty survey value wipe the category picked at signup —
        // only an explicitly-provided course updates it.
        if (preferedCourse) {
          foundUser.assignedCourse = preferedCourse
        }

        // Save the user document with the updated survey data
        await foundUser.save();

        return res.status(200).json({ message: 'Survey data saved successfully' });
      } else {
        return res.status(404).json({ message: 'User not found' });
      }
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during survey processing' });
    }
  },

  aptitudeTest: async (req, res) => {
    try {
      const {
        willDadicate6Hours,
        describeSelf,
        personality,
        doForFun,
      } = req.body;

      // Get user ID from the request headers
      const userId = req.params.userId;

      // Query the user database to get the user's role
      const foundUser = await User.findById(userId);

      if (foundUser) {
        // Update the aptitudeTest data in the user document
        foundUser.aptitudeTest = {
          willDadicate6Hours,
          describeSelf,
          personality,
          doForFun,
        };

        // Save the user document with the updated aptitudeTest data
        await foundUser.save();

        return res.status(200).json({ message: 'AptitudeTest data saved successfully' });
      } else {
        return res.status(404).json({ message: 'User not found' });
      }
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during Aptitude Test processing' });
    }
  },

  updateScore: async (req, res) => {
    try {
      const { assessmentId, userId, score } = req.body;

      // Validate input
      if (!assessmentId || !userId || score === undefined) {
        return res.status(400).json({ message: "Invalid input data." });
      }

      // Fetch the assessment
      const assessment = await Assessment.findById(assessmentId);
      if (!assessment) {
        return res.status(404).json({ message: "Assessment not found." });
      }

      // Find the user in responses. Named `entry` rather than reusing `res`,
      // which is the response object this handler replies with.
      const response = assessment.responses.find(
        (entry) => String(entry.student) === String(userId)
      );

      if (!response) {
        return res
          .status(404)
          .json({ message: "User response not found for this assessment." });
      }

      // Only the first grade is announced. Providers reopen the Scoring modal to
      // correct a score, and without this guard every correction would re-send
      // the email, so the student would get one message per edit rather than the
      // single completion message the feature calls for.
      const isFirstGrade = response.score === undefined || response.score === null;

      // Update the user's score
      response.score = score;

      // Save the updated assessment
      await assessment.save();

      if (isFirstGrade) {
        const student = await User.findById(userId).select('email fullname');
        // The score is already stored; a mail failure must not turn a successful
        // grade into a 500.
        await sendAssessmentEmailSafely('Assessment scored', () =>
          sendAssessmentScoredEmail({
            student,
            assessment,
            score,
          })
        );
      }

      return res.status(200).json({
        success: true,
        message: "Score updated successfully.",
      });
    } catch (error) {
      console.error("Error updating score:", error);
      return res.status(500).json({ message: "Unexpected error occurred." });
    }
  },

}
module.exports = assessmentControllers;