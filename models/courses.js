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
    primaryColor: {
        type: String,
        default: "#FDC332"
    },
    calendarEventId: String,
    privacy: {
        student: String,
    },
    about: String,
    instructorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    duration: Number,
    type: String,
    startDate: String,
    endDate: String,
    startTime: String,
    endTime: String,
    fee: Number,
    strikedFee: Number,
    // Part payment is a platform capability, not a per-course setting: any paid
    // course can be paid for in parts and the student chooses each amount, so
    // there is deliberately no instructor-facing installment policy here.
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
            type: Date
        },
        status: {
            type: String,
            enum: ['active', 'payment_plan_active', 'expired', 'suspended', 'scholarship'],
            default: 'active'
        },
        updatedAt: {
            type: Date
        },
        // Scholarship metadata was previously pushed by the controller but had no
        // schema path, so Mongoose silently discarded it and grants were untraceable.
        scholarship: {
            type: Boolean,
            default: false
        },
        grantedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
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
            duration: Number,
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
    }],
    // Optional seat cap. Null/absent means unlimited, preserving existing behaviour
    // for every course created before capacity existed.
    capacity: {
        type: Number,
        min: 1,
        required: false
    },
    enrollmentDeadline: {
        type: Date,
        required: false
    }
}, { timestamps: true });

// "Which courses is this student enrolled in?" runs on every dashboard load;
// without these it is a full collection scan per request.
courseSchema.index({ enrolledStudents: 1 });
courseSchema.index({ 'enrollments.user': 1 });
courseSchema.index({ instructorId: 1 });
courseSchema.index({ approved: 1, category: 1 });


//populate enrolled students
courseSchema.methods.populateEnrolledStudents = async function () {
    // execPopulate() was removed in Mongoose 6; document.populate() now returns a promise.
    await this.populate('enrolledStudents');
};



const Course = new mongoose.model("Course", courseSchema);



module.exports = Course;