const mongoose = require('mongoose');


const eventSchema = new mongoose.Schema({
  title: String,
  thumbnail: {
    type: {
      type: String,
      required: true
    },
    url: {
      type: String,
      required: true
    }
  },
  category: String,
  meetingId: String,
  meetingPassword: String,
  zakToken: String,
  meetingLink: String,
  meetingMode: {
    type: String,
    enum: ["zoom", "google"],
  },
  calendarEventId: String,
  about: String,
  author: String,
  authorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  duration: Number,
  mode: String,
  videoUrl: String,
  days: [{
    checked: Boolean,
    day: String,
    startTime: String,
    endTime: String
  }],
  type: String,
  startDate: String,
  endDate: String,
  startTime: String,
  endTime: String,
  fee: Number,
  strikedFee: Number,
  target: Number,

  enrolledStudents: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  timeframe: {
    value: Number,
    unit: String,
  },
  location: String,
  room: String,
});



const LearningEvent = new mongoose.model("LearningEvent", eventSchema);


module.exports = LearningEvent;