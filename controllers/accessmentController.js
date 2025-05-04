const User = require("../models/user.js");
const Assessment = require("../models/assessment.js");
const { upload } = require("../config/cloudinary.js");
const Notification = require("../models/notifications.js");
const mongoose = require("mongoose");


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

      return res.status(200).json({ assessmentQuestions });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during assessment questions retrieval' });
    }
  },

  getSingleAssesment: async (req, res) => {
    try {
      const id = req.params.id

      const myAssesment = await Assessment.find({ _id: id }).populate({ path: 'responses.student', select: "profilePicture fullname _id" }).lean()

      return res.status(200).json({ message: 'Assesment retrieved successfully', myAssesment });

    } catch (error) {
      console.error(error);
      return res.status(500).json(error);
    }
  },

  getAssignedAssesment: async (req, res) => {
    try {
      const userId = req.params.id

      const myAssesment = await Assessment.find({ assignedStudents: { _id: userId } });

      return res.status(200).json({ message: 'User assesment retrieved successfully', myAssesment });

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


      console.log(studentId)
      myAssesment.assignedStudents.push(studentId);


      await myAssesment.save();
      await Notification.create({
        title: "Assesmet assigned",
        content: `${user.fullname} sent you an Assessment`,
        contentId: myAssesment.id,
        userId: studentId,
      });
      return res.status(200).json({ message: 'User assesment Assigned successfully', myAssesment });

    } catch (error) {
      console.error(error);
      return res.status(500).json(error);
    }
  },

  editAssesment: async (req, res) => {
    try {
      const assesment = await Assessment.updateOne({
        _id: req.params.id
      }, {
        ...req.body
      }, {
        new: true
      })
      res.json(assesment);
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

      // Add the student's response to the responses array
      assessment.responses.push({
        student: studentId,
        answers,
      });

      // Save the updated assessment
      await assessment.save();

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
          preferedCourse,
          yearsOfExperience,
          currentEducation,
          joiningAccomplishment,
        };

        foundUser.assignedCourse = preferedCourse

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

      // Find the user in responses
      const response = assessment.responses.find(
        (res) => res.student.toString() === userId
      );

      if (!response) {
        return res
          .status(404)
          .json({ message: "User response not found for this assessment." });
      }

      // Update the user's score
      response.score = score;

      // Save the updated assessment
      await assessment.save();

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