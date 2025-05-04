const mongoose = require('mongoose');


const courseSchema = new mongoose.Schema({
    title: String,
    instructorName: String,
    instructorImage: String,
    file: String,
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
    privacy: {
        student: String,
    },
    about: String,
    instructorId: String,
    duration: Number,
    type: String,
    startDate: String,
    endDate: String,
    startTime: String,
    endTime: String,
    fee: Number,
    strikedFee: Number,
    target: Number,
    assignedTutors: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    enrolledStudents: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    audience: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    enrollments: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        enrolledOn: {
            type: String
        },
        status: {
            type: String
        },
        updatedAt: {
            type: String
        }
    }],
    days: [{
        checked: Boolean,
        day: String,
        startTime: String,
        endTime: String
    }],
    location: String,
    room: String,
    videos: [{
        title: String,
        videoUrl: String,
        submodules: [{
            title: String,
            videoUrl: String,
        }],
    }],
    approved: {
        type: Boolean,
        default: false,
    },
    modules: [{
        title: String,
        description: String
    }],
    timeframe: {
        value: Number,
        unit: String,
    },
    benefits: [{
        type: String
    }]
});


//populate enrolled students
courseSchema.methods.populateEnrolledStudents = async function () {
    await this.populate('enrolledStudents').execPopulate();
};



const Course = new mongoose.model("Course", courseSchema);



module.exports = Course;