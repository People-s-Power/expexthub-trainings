const mongoose = require('mongoose');

const assessmentSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    image: {
      type: String,
      required: true
    },
    assignedStudents: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    tutor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    // Free-text guidance shown to the student before they start. Optional — the
    // assignment email includes it only when the provider wrote one.
    instructions: {
      type: String,
    },
    assesment: [
      {
        question: {
          type: String,
          required: true,
        },
        // The canonical list of answer options, any length. Providers add and
        // remove options here; `correctAnswerIndex` is an index into it.
        options: [
          {
            type: String,
          }
        ],
        // Legacy three-option fields. Still declared because assessments created
        // before `options` existed store their answers here and must keep reading
        // and writing cleanly. New questions never populate them; the controller's
        // normalizeAssessment() projects them into `options` on the way out.
        answerA: {
          type: String,
        },
        answerB: {
          type: String,
        },
        answerC: {
          type: String,
        },
        correctAnswerIndex: {
          type: Number,
          validate: {
            // Bounded by this question's own option count rather than a fixed
            // three, so adding or removing an option stays valid. Documents
            // written before `options` existed fall back to their three
            // answerA/B/C fields.
            validator: function (value) {
              var count = Array.isArray(this.options) && this.options.length
                ? this.options.length
                : 3;
              return value >= 0 && value < count;
            },
            message: 'Correct answer index must point at one of the options.',
          },
        },
      }
    ],
    type: {
      type: String,
      required: true
    },
    responses: [
      {
        student: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        score: {
          type: Number
        },
        answers: [
          {
            answer: {
              type: String,
            },
            // Which question this answer belongs to. Answers used to be matched
            // to questions by array position, so deleting a question from the
            // middle shifted every later answer onto the wrong question in the
            // scoring view. Older responses predate this field and still fall
            // back to positional matching.
            questionId: {
              type: mongoose.Schema.Types.ObjectId,
            },
          }
        ]
      }
    ]
  }

);

const Assessment = mongoose.model('Assessment', assessmentSchema);

module.exports = Assessment;