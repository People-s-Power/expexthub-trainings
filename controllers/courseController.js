import Course from "../models/courses.js";
import User from "../models/user.js"
import upload from "../config/cloudinary.js";
import createZoomMeeting from "../utils/createZoomMeeting.js";
import KJUR from "jsrsasign"
const categories = ["Virtual Assistant", "Product Management", "Cybersecurity", "Software Development", "AI / Machine Learning", "Data Analysis & Visualisation", "Story Telling", "Animation", "Cloud Computing", "Dev Ops", "UI/UX Design", "Journalism", "Game development", "Data Science", "Digital Marketing", "Advocacy"]



const courseController = {

    getAllCategory: async (req, res) => {
        try {
            const allCourse = []

            await Promise.all(categories.map(async (category) => {
                const courses = await Course.find({ category });
                if (courses.length !== 0) {
                    allCourse.push({
                        category,
                        courses
                    })
                }
            }))
            return res.status(200).json({ allCourse });

        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching courses category' });
        }
    },

    getCourseByCategory: async (req, res) => {
        const category = req.params.category;

        try {
            const courses = await Course.find({ category });

            return res.status(200).json({ courses });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching courses by category' });
        }
    },

    getCourseById: async (req, res) => {
        const courseId = req.params.courseId;

        // Validate if courseId is a valid ObjectId
        // if (!ObjectId.isValid(courseId)) {
        //     return res.status(400).json({ message: 'Invalid course ID' });
        // }

        try {
            const course = await Course.findById(courseId);

            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }

            return res.status(200).json({ course });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching the course' });
        }
    },


    getAllCourses: async (req, res) => {
        try {
            const courses = await Course.find();

            return res.status(200).json({ courses });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching all courses' });
        }
    },

    getZoomSignature: async (req, res) => {

        const iat = Math.round(new Date().getTime() / 1000) - 30;
        const exp = iat + 60 * 60 * 2

        const oHeader = { alg: 'HS256', typ: 'JWT' }

        const oPayload = {
            sdkKey: process.env.SDK_CLIENT_ID,
            mn: req.body.meetingNumber,
            role: 0,
            iat: iat,
            exp: exp,
            appKey: process.env.SDK_CLIENT_ID,
            tokenExp: iat + 60 * 60 * 2
        }

        const sHeader = JSON.stringify(oHeader)
        const sPayload = JSON.stringify(oPayload)
        const signature = KJUR.jws.JWS.sign('HS256', sHeader, sPayload, process.env.SDK_CLIENT_SECRET)

        res.json({
            signature: signature
        })

    },

    addCourse: async (req, res) => {
        const { title, instructorName, about, duration, type, startDate, endDate, startTime, endTime, category, privacy, fee, strikedFee, scholarship, meetingPassword } = req.body;

        // Get user ID from the request headers
        const userId = req.params.userId;

        // Query the user database to get the user's role
        const user = await User.findById(userId);

        // Check if the user has the necessary role to add a course
        const allowedRoles = ['tutor', 'admin', 'super admin'];
        if (!user || !allowedRoles.includes(user.role)) {
            return res.status(403).json({ message: 'Permission denied. Only tutors and admins can add courses' });
        }

        try {
            // Check if a file was uploaded
            // if (!req.files || !req.files.image) {
            //     return res.status(400).json({ success: false, error: 'Please upload an image' });
            // }

            // const { image } = req.files;
            // const fileTypes = ['image/jpeg', 'image/png', 'image/jpg'];
            // const imageSize = 50024;

            // if (!fileTypes.includes(image.mimetype)) return res.send('Image formats supported: JPG, PNG, JPEG');

            // if (image.size / 1024 > imageSize) return res.send(`Image size should be less than ${imageSize}kb`);

            // Upload image to Cloudinary
            // const cloudFile = await upload(image.tempFilePath);
            const cloudFile = await upload(req.body.image);

            // Create a new course object
            const newCourse = {
                instructorName: user.fullname,
                title,
                about,
                duration,
                type, //online, pdf, offline, video
                startDate,
                endDate,
                startTime,
                endTime,
                category,
                privacy,
                fee,
                strikedFee,
                scholarship,
                thumbnail: cloudFile.url,  // Set the thumbnail field with the Cloudinary URL
            };

            // Save the new course
            const course = await Course.create(newCourse);

            if (newCourse.type === "pdf") {
                // const { pdf } = req.files;
                const cloudFile = await upload(req.body.pdf);
                // const cloudFile = await upload(pdf.tempFilePath);
                course.file = cloudFile.secure_url
                await course.save()
            }

            if (newCourse.type === "offline") {
                course.room = req.body.room
                course.location = req.body.location
                await course.save()
            }

            if (newCourse.type === 'video') {
                let newVideos = []
                const videos = req.body.videos
                videos.map(async video => {
                    const cloudFile = await upload(video.videoUrl)
                    newVideos.push({
                        title: video.title,
                        videoUrl: cloudFile.secure_url
                    })
                })

                course.video = newVideos
                await course.save()
            }

            //Creating an online course 
            if (newCourse.type === "online") {
                //....Args -- course topic, course duration, scheduled date of the course, zoom password for course,
                const meetingData = await createZoomMeeting(course.title, parseInt(course.duration), new Date(startDate), meetingPassword)
                if (meetingData.success) {
                    course.meetingId = meetingData.meetingId
                    course.meetingPassword = meetingData.meetingPassword
                    course.zakToken = meetingData.zakToken
                    await course.save()
                }
            }

            return res.status(201).json({
                success: true,
                message: 'Course added successfully',
                imageUrl: cloudFile.url,
                course,
            });
        } catch (error) {
            console.log(error);
            return res.status(500).json({ message: 'Unexpected error during course creation' });
        }
    },


    // course admission
    enrollCourse: async (req, res) => {
        const courseId = req.params.courseId;
        const studentId = req.body.id;
        try {

            const course = await Course.findById(courseId);


            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }

            // Check if the student is already enrolled
            if (course.enrolledStudents.includes(studentId)) {
                return res.status(400).json({ message: 'Student is already enrolled in the course' });
            }

            // Enroll the student in the course
            course.enrolledStudents.push(studentId);
            await course.save();

            return res.status(200).json({ message: 'Enrolled successfully' });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error during enrollment' });
        }
    },

    getEnrolledCourses: async (req, res) => {
        const userId = req.params.userId;

        try {
            // Find the user by ID
            // const user = await User.findById(userId);

            // if (!user) {
            //     return res.status(404).json({ message: 'User not found' });
            // }

            // Get the enrolled courses using the user's enrolledCourses array
            const enrolledCourses = await Course.find({ enrolledStudents: { _id: userId } });
            // console.log(enrolledCourses)

            if (!enrolledCourses || enrolledCourses.length === 0) {
                return res.status(404).json({ message: 'No enrolled courses found for this user' });
            }

            return res.status(200).json({ message: 'Enrolled courses retrieved successfully', enrolledCourses });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error during enrolled courses retrieval' });
        }
    },


    getEnrolledStudents: async (req, res) => {
        const courseId = req.params.courseId;

        try {
            const course = await Course.findById(courseId);

            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }

            // Fetch details of enrolled students
            const enrolledStudents = await User.find({ _id: { $in: course.enrolledStudents } });

            if (!enrolledStudents || enrolledStudents.length === 0) {
                return res.status(404).json({ message: 'No enrolled students found for this course' });
            }

            // Extract relevant student information
            const enrolledStudentsProfiles = enrolledStudents.map(student => ({
                fullname: student.fullname,
                email: student.email,
                phone: student.phone,
                gender: student.gender,
                age: student.age,
                skillLevel: student.skillLevel,
                country: student.country,
                state: student.state,
                address: student.address,
            }));

            return res.status(200).json({ message: 'Enrolled students retrieved successfully', enrolledStudents: enrolledStudentsProfiles });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error during enrolled students retrieval' });
        }
    },

    // fetch roundom courses
    getRecommendedCourses: async (req, res) => {
        try {
            const userId = req.params.userId

            const user = await User.findOne({ _id: userId })
            const category = user.assignedCourse
            // const numberOfCourses = 4; // Set the number of recommended courses you want
            const count = await Course.countDocuments();

            if (count === 0) {
                return res.status(404).json({ message: 'No courses available' });
            }

            // Generate an array of unique random indices
            // const randomIndices = [];
            // while (randomIndices.length < numberOfCourses) {
            //     const randomIndex = Math.floor(Math.random() * count);
            //     if (!randomIndices.includes(randomIndex)) {
            //         randomIndices.push(randomIndex);
            //     }
            // }

            const courses = await Course.find({ category })
            const recommendedCourses = await courses.map((course) => {
                if (course.enrolledStudents.includes(userId)) {
                    return null
                } else {
                    return course
                }
            }).filter(item => item !== null)
            // console.log(recommendedCourses)

            // Fetch the recommended courses based on random indices
            // const recommendedCourses = await Course.find({ category: user.assignedCourse }).skip(randomIndices[0]).limit(numberOfCourses);

            if (!recommendedCourses || recommendedCourses.length === 0) {
                return res.status(404).json({ message: 'No courses available' });
            }

            return res.status(200).json({ courses: recommendedCourses });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching recommended courses' });
        }
    },

    editCourse: async (req, res) => {
        try {
            const course = await Course.updateOne({
                _id: req.params.id
            }, {
                ...req.body
            }, {
                new: true
            })
            res.json(course);
        } catch (error) {
            console.error(error);
            res.status(400).json(error);
        }
    },

    deleteCourse: async (req, res) => {
        try {
            const course = await Course.deleteOne({
                _id: req.params.id
            })
            res.json(course);
        } catch (error) {
            console.error(error);
            res.status(400).json(error);
        }
    }
};



export default courseController;


