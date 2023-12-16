import mongoose from "mongoose";


const courseSchema = new mongoose.Schema({
    title: String,
    file: String,
    category: String,
    privacy: {
        student: String,
    },
    about: String,
    instructor: String,
    duration: Number,
    type: String,
    startDate: String,
    endDate: String,
    startTime: String,
    endTime: String,
    fee: Number,
    strikedFee: Number,
    resources: {
        title: String,
        privacy: {
            student: String,
            courses: String
        },
        websiteUrl: String,
        aboutCourse: String
    },
    scholarship: {
        student: String,
        courses: String,
        courseCategory: String,
    },

    enrolledStudents: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],

    videos: [{
        title: String,
        videoUrl: String,
    }],

});


//populate enrolled students
courseSchema.methods.populateEnrolledStudents = async function () {
    await this.populate('enrolledStudents').execPopulate();
};



const Course = new mongoose.model("Course", courseSchema);



export default Course;