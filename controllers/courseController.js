const Course = require("../models/courses.js");
const Event = require("../models/event.js");

const User = require("../models/user.js");
const Category = require("../models/category.js");
const { upload, getSignature } = require("../config/cloudinary.js");
const { cloudinaryVidUpload } = require("../config/cloudinary.js");
const createZoomMeeting = require("../utils/createZoomMeeting.js");
const KJUR = require("jsrsasign");
const Notification = require("../models/notifications.js");
const Transaction = require("../models/transactions.js");
const CoursePaymentPlan = require("../models/coursePaymentPlans.js");
const dayjs = require("dayjs");
const isBetween = require("dayjs/plugin/isBetween.js");
const isSameOrAfter = require("dayjs/plugin/isSameOrAfter.js");
const LearningEvent = require("../models/event.js");
const { createGoogleMeet } = require("../utils/createGoogleMeeting.js");
const { default: mongoose } = require("mongoose");
const { creditInstructor } = require("../services/coursePaymentService.js");

dayjs.extend(isBetween)
dayjs.extend(isSameOrAfter)


// const categories = ["Virtual Assistant", "Product Management", "Cybersecurity", "Software Development", "AI / Machine Learning", "Data Analysis & Visualisation", "Story Telling", "Animation", "Cloud Computing", "Dev Ops", "UI/UX Design", "Journalism", "Game development", "Data Science", "Digital Marketing", "Advocacy"]



const courseController = {

    getAllCategory: async (req, res) => {
        try {
            const userId = req.query.id
            console.log(userId);

            const allCourse = []
            const categories = await Category.findOne({ _id: "66191b8819d5dab6af174540" })

            await Promise.all(categories.subCategory.map(async (category) => {
                const courses = await Course.find({
                    category,
                    approved: true,
                    $or: [
                        { audience: { $exists: false } },
                        { audience: { $size: 0 } },
                        { audience: userId },
                    ],
                }).populate({
                    path: 'enrolledStudents',
                    select: 'profilePicture fullname _id',
                }).lean();


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
        const category = req.body.category;

        try {
            const courses = await Course.find({ category, approved: true }).populate({ path: 'enrolledStudents', select: "profilePicture fullname _id" }).lean();;

            return res.status(200).json({ courses });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching courses by category' });
        }
    },

    getAuthorCourse: async (req, res) => {
        const userId = req.body.id;

        try {


            const courses = await Course.find().populate({ path: 'enrolledStudents', select: "profilePicture fullname _id" }).lean();

            return res.status(200).json({ courses: courses.filter(course => (course.instructorId.toString() === userId) || course.assignedTutors?.map(id => id.toString()).includes(userId)) });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching courses' });
        }
    },
    getPlatformCOurses: async (req, res) => {
        const instructorId = req.params.userId;

        try {
            const courses = await Course.find({
                instructorId
            }).populate({ path: 'enrolledStudents', select: "profilePicture fullname _id" }).lean();;

            return res.status(200).json({ courses });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching courses' });
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
            const instructor = await User.findById(course.instructorId);


            return res.status(200).json({ course, instructor });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching the course' });
        }
    },


    getAllCourses: async (req, res) => {
        try {

            const courses = await Course.find({
                approved: true,

            }).populate({
                path: 'enrolledStudents assignedTutors',
                select: "profilePicture fullname _id"
            }).lean();

            // console.log(courses.filter(course => course.type === "video"), "yes oo");

            return res.status(200).json({ courses: courses });

            // return res.status(200).json({ courses: courses.filter(course => dayjs(course.endDate).isSameOrAfter(dayjs(), 'day')) });
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
            role: req.body.role,
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

        const { title, about, duration, type, startDate, endDate, startTime, endTime, category, privacy, days, fee, strikedFee, scholarship, meetingPassword, target, modules, benefits, timeframe, audience, meetingType, primaryColor, installmentsEnabled, installmentCount } = req.body;

        // Get user ID from the request headers
        const userId = req.params.userId;


        // Query the user database to get the user's role
        const user = await User.findById(userId);
        let coursesByUser = await Course.find({
            instructorId: userId,
        });
        console.log("hmmm na me oo i no know");

        coursesByUser = [...coursesByUser, ...(await LearningEvent.find({
            authorId: userId,
        }))]
        // Check if the user has the necessary role to add a course
        const allowedRoles = ['tutor', 'admin', 'super admin', 'super-admin'];
        if (!user || !allowedRoles.includes(user.role)) {
            return res.status(403).json({ message: 'Permission denied. Only tutors and admins can add courses' });
        }

        if (type === "online") {
            const allowedMeetingModes = ["zoom", "google"];
            if (!meetingType || !allowedMeetingModes.includes(meetingType)) {
                return res.status(400).json({
                    message: "Invalid meetingType. Please select either zoom or google.",
                });
            }
        }

        const scholarshipIds = Array.isArray(scholarship)
            ? scholarship.filter((id) => mongoose.Types.ObjectId.isValid(id))
            : [];

        const audienceIds = Array.isArray(audience)
            ? audience.filter((id) => mongoose.Types.ObjectId.isValid(id))
            : [];

        // Validate installment settings when provided. Free courses cannot offer
        // installments regardless of the flag, so clients only send these for paid courses.
        let validatedInstallmentsEnabled = false;
        let validatedInstallmentCount = 3;
        if (fee && Number(fee) > 0) {
            validatedInstallmentsEnabled = Boolean(installmentsEnabled);
            if (validatedInstallmentsEnabled) {
                const count = Number(installmentCount);
                if (Number.isInteger(count) && count >= 2 && count <= 6) {
                    validatedInstallmentCount = count;
                } else if (installmentCount !== undefined) {
                    return res.status(400).json({ message: 'Installment count must be between 2 and 6' });
                }
            }
        }


        if (user.role === "tutor" && ((user.premiumPlan === "basic" && coursesByUser.length >= 5) || user.premiumPlan === "standard" && coursesByUser.length >= 20)) {
            return res.status(403).json({ message: 'Your have exceeded your plan limit for courses', showPop: true });
        }
        try {
            let cloudFile;
            try {
                if (req.body.asset.type === 'image') {
                    // Upload image with timeout handling
                    const file = await upload(req.body.asset.url, "image");
                    cloudFile = file;
                } else {
                    // Upload video with specific video handling
                    const video = await cloudinaryVidUpload(req.body.asset.url);
                    cloudFile = video;
                }

                if (!cloudFile) {
                    return res.status(500).json({
                        message: 'File upload failed. Please try with a smaller file or better connection.'
                    });
                }
            } catch (uploadError) {
                console.error("Upload error:", uploadError);
                return res.status(500).json({
                    message: 'File upload failed: ' + (uploadError.message || 'Unexpected error during file upload'),
                    details: uploadError.http_code === 499 ? 'Request timed out. Try with a smaller file or better connection.' : null
                });
            }

            // Create a new course object
            const newCourse = {
                instructorId: userId,
                instructorName: user.fullname,
                instructorImage: user.profilePicture,
                title,
                about,
                duration,
                type,
                startDate,
                endDate,
                startTime,
                endTime,
                category,
                privacy,
                target,
                fee,
                primaryColor,
                days,
                strikedFee,
                installmentsEnabled: validatedInstallmentsEnabled,
                installmentCount: validatedInstallmentCount,
                modules,
                benefits,
                enrolledStudents: scholarshipIds,
                audience: audienceIds,
                thumbnail: {
                    type: req.body.asset.type,
                    url: cloudFile
                },
                timeframe,
                meetingMode: meetingType,
            };
            if (type === 'online') {
                if ((meetingType === "zoom") && (parseInt(duration) > parseInt(process.env.NEXT_PUBLIC_MEETING_DURATION))) {
                    return res.status(400).json({ message: `Live courses have a limit of ${process.env.NEXT_PUBLIC_MEETING_DURATION} minutes` });
                }
            }

            // Save the new course
            const course = await Course.create(newCourse);

            // Handle scholarship students by adding them to the enrollments array as well
            if (scholarshipIds.length > 0) {
                // Initialize enrollments array if it doesn't exist
                if (!course.enrollments) {
                    course.enrollments = [];
                }

                // Add each scholarship student to enrollments array with proper metadata
                scholarshipIds.forEach(studentId => {
                    course.enrollments.push({
                        user: studentId,
                        status: 'active',
                        enrolledOn: new Date(),
                        scholarship: true // Mark as scholarship student
                    });
                });

                // Save the updates
                await course.save();
            }

            if (newCourse.type === "pdf") {
                // const { pdf } = req.files;
                const cloudFile = await upload(req.body.pdf);
                // const cloudFile = await upload(pdf.tempFilePath);
                course.file = cloudFile
                await course.save()
            }

            if (newCourse.type === "offline") {
                course.room = req.body.room
                course.location = req.body.location
                await course.save()
            }

            if (newCourse.type === 'offline' || course.type === 'online') {
                course.days = req.body.days
                await course.save()
            }


            if (newCourse.type === 'video') {
                for (const video of req.body.videos) {
                    course.videos.push({
                        title: video.title,
                        videoUrl: video.videoUrl,
                        duration: video.duration,
                        submodules: video.submodules.map(submodule => {
                            return {
                                title: submodule.title,
                                videoUrl: submodule.videoUrl,
                                duration: submodule.duration
                            }
                        })
                    });
                }
            }



            if (newCourse.type === "online") {
                const dayMap = {
                    "Sunday": 7,
                    "Monday": 1,
                    "Tuesday": 2,
                    "Wednesday": 3,
                    "Thursday": 4,
                    "Friday": 5,
                    "Saturday": 6
                };

                // meeting provider is stored as `meetingMode` on the course model
                if (newCourse.meetingMode === "zoom") {
                    const getZoomWeeklyDaysFormat = (days) => {
                        return days
                            .filter(day => day.checked)
                            .map(day => dayMap[day.day])
                            .join(',');
                    };
                    const weeks = getZoomWeeklyDaysFormat(days)
                    const meetingData = await createZoomMeeting(course.title, parseInt(course.duration), startDate, endDate, weeks, meetingPassword)
                    if (meetingData.success) {
                        course.meetingId = meetingData.meetingId
                        course.meetingPassword = meetingData.meetingPassword
                        course.zakToken = meetingData.zakToken
                    }

                } else {


                    const meetingData = await createGoogleMeet(user, {
                        title: course.title,
                        about: course.about,
                        startDate,
                        endDate,
                        days,
                        audience,
                    });

                    if (meetingData.success) {
                        course.meetingLink = meetingData.meetLink;
                        course.calendarEventId = meetingData.calendarEventId;
                    } else {
                        return res.status(500).json({ message: meetingData.message });
                    }
                }




            }
            //just for now
            course.approved = true;
            await course.save()


            const adminUsers = await User.find({ role: { $in: ["admin", "super-admin"] } });
            adminUsers.forEach(async (adminUser) => {
                try {
                    await Notification.create({
                        title: "Course created",
                        content: `${user.fullname} just created a new course on ${course.title}`,
                        contentId: course._id,
                        userId: adminUser._id,
                    });
                } catch (error) {
                    console.error("Error creating notification:", error);
                }
            });
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

    getUnaproved: async (req, res) => {
        try {
            const courses = await Course.find({ approved: false });

            return res.status(200).json({ courses });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching courses by category' });
        }
    },
    getLive: async (req, res) => {
        try {


            const dbCourses = await Course.find({
                type: 'online',
            })
                .sort({ startDate: -1 })
                .lean();

            const dbEvents = await Event.find({
                type: 'online',
            }).sort({ startDate: -1 })
                .lean();

            const courses = [...dbCourses, ...dbEvents].filter(data => {
                return dayjs(data.endDate).isSameOrAfter(dayjs(), 'day');
            })
            return res.status(200).json(courses);
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching courses by category' });
        }
    },
    getSignedURL: async (req, res) => {
        try {
            const data = await getSignature()
            return res.status(200).json({ ...data });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching signature' });
        }
    },
    approveCourse: async (req, res) => {
        const courseId = req.params.courseId;
        try {

            const course = await Course.findById(courseId);

            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }

            // Approve the course
            course.approved = true;
            await course.save();

            return res.status(200).json({ message: 'Approved successfully' });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error during enrollment' });
        }
    },

    // course admission
    enrollCourse: async (req, res) => {
        const courseId = req.params.courseId;

        // Always the authenticated user. Honouring req.body.id here let any signed-in
        // account enrol somebody else, and let a student enrol into a paid course by
        // passing the id of a user who had already paid.
        const id = req.user?.id || req.user?._id;

        try {
            if (!id) {
                return res.status(401).json({ message: 'Authentication required' });
            }

            const [course, user] = await Promise.all([
                Course.findById(courseId),
                User.findById(id),
            ]);
            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            if (user.blocked) {
                return res.status(403).json({ message: 'Your account is not permitted to enroll' });
            }
            if (!user.isVerified) {
                return res.status(403).json({ message: 'Please verify your email before enrolling' });
            }
            if (!course.approved) {
                return res.status(403).json({ message: 'This course is not open for enrollment yet' });
            }
            if (String(course.instructorId) === String(id)) {
                return res.status(400).json({ message: 'You cannot enroll in your own course' });
            }
            if (course.enrollmentDeadline && new Date(course.enrollmentDeadline) < new Date()) {
                return res.status(409).json({ message: 'Enrollment for this course has closed' });
            }
            if ((course.enrolledStudents || []).some(studentId => String(studentId) === String(id))) {
                return res.status(409).json({ message: 'Student is already enrolled in the course' });
            }
            if (course.capacity && (course.enrolledStudents || []).length >= course.capacity) {
                return res.status(409).json({ message: 'This course is full' });
            }

            // Paid courses can only be accessed after a server-confirmed payment.
            // Free and scholarship enrollments continue to use this endpoint.
            if (Number(course.fee || 0) > 0) {
                const [paidTransaction, activePlan] = await Promise.all([
                    Transaction.findOne({
                        userId: id,
                        courseId,
                        type: { $in: ['course_payment', 'course_payment_wallet'] },
                        status: 'successful',
                    }),
                    // Any plan with at least one installment paid already grants access,
                    // so a part-paid student is not blocked from the course they bought.
                    CoursePaymentPlan.findOne({
                        userId: id,
                        courseId,
                        status: { $in: ['active', 'completed', 'overdue'] },
                        amountPaidMinor: { $gt: 0 },
                    }),
                ]);
                if (!paidTransaction && !activePlan) {
                    return res.status(402).json({ message: 'Please complete payment before enrolling in this course' });
                }
            }

            // Conditional write: two concurrent requests cannot both append an
            // enrollment, and the capacity ceiling is re-checked atomically.
            const capacityFilter = course.capacity
                ? { [`enrolledStudents.${course.capacity - 1}`]: { $exists: false } }
                : {};
            const result = await Course.updateOne(
                { _id: course._id, enrolledStudents: { $ne: user._id }, ...capacityFilter },
                {
                    $addToSet: { enrolledStudents: user._id },
                    $push: {
                        enrollments: {
                            user: user._id,
                            status: 'active',
                            enrolledOn: new Date(),
                        },
                    },
                },
            );
            if (result.modifiedCount === 0) {
                const fresh = await Course.findById(course._id).select('enrolledStudents capacity').lean();
                const nowEnrolled = (fresh?.enrolledStudents || []).some(studentId => String(studentId) === String(id));
                if (nowEnrolled) {
                    return res.status(409).json({ message: 'Student is already enrolled in the course' });
                }
                return res.status(409).json({ message: 'This course is full' });
            }

            await User.updateOne({ _id: user._id }, { $set: { contact: false } });

            // A failed notification must not fail an accepted enrollment.
            try {
                await Notification.create({
                    title: "Course enrolled",
                    content: `${user.fullname} just enrolled for your course ${course.title}`,
                    contentId: course._id,
                    userId: course.instructorId,
                });
            } catch (notificationError) {
                console.error('Enrollment notification failed:', notificationError.message);
            }

            return res.status(200).json({ message: 'Enrolled successfully', courseId: course._id });
        } catch (error) {
            console.error('Enrollment failed:', error);
            return res.status(500).json({ message: 'Unexpected error during enrollment' });
        }
    },

    assignTutor: async (req, res) => {
        const courseId = req.params.courseId;

        const { id } = req.body

        try {

            const course = await Course.findById(courseId);
            const user = await User.findById(id);

            console.log(user);
            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }
            console.log(course);
            // Check if the student is already enrolled
            if (course.assignedTutors.includes(id)) {
                await Course.updateOne(
                    { _id: course._id },
                    { $pull: { assignedTutors: id } }
                );
                return res.status(200).json({ message: 'Tutor is Unassigned to this course' });
            } else {
                course.assignedTutors.push(id);
                course.contact = false
                await course.save();

                await Notification.create({
                    title: "Tutor Assigned",
                    content: `${user.fullname} was assigned to your Course ${course.title}`,
                    contentId: course._id,
                    userId: course.instructorId,
                });
            }

            return res.status(200).json({ message: 'Assigned successfully' });

        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error during assignment' });
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
            const enrolledCourses = await Course.find({
                $or: [
                    { "enrolledStudents": userId },
                    { "enrollments.user": userId }
                ]
            }).populate({ path: 'enrolledStudents', select: "profilePicture fullname _id" }).sort({ startDate: -1 }).lean();
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
            const category = [user.assignedCourse, ...user.otherCourse]
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
            const courses = await Course.find({ category: { $in: category }, approved: true }).sort({ _id: -1 })

            const recommendedCourses = await courses.map((course) => {

                if (course.enrolledStudents.includes(userId)) {
                    return null
                } else if (course.enrollments?.find(student => student.user?.toString() === userId)) {
                    return null
                }
                else {
                    return course
                }
            }).filter(item => item !== null)
            // console.log(recommendedCourses)

            // Fetch the recommended courses based on random indices
            // const recommendedCourses = await Course.find({ category: user.assignedCourse }).skip(randomIndices[0]).limit(numberOfCourses);



            if (!recommendedCourses || recommendedCourses.length === 0) {
                return res.status(404).json({ message: 'No courses available' });
            }

            return res.status(200).json({ courses: recommendedCourses.filter(course => course.audience.length === 0 || course.audience.includes(userId)) });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error while fetching recommended courses' });
        }
    },

    editCourse: async (req, res) => {
        try {
            const courseId = req.params.id;
            const course = await Course.findById(courseId);
            if (!course) return res.status(404).json({ message: 'Course not found' });

            let videos = req.body.videos.map(video => {
                return {
                    title: video.title,
                    videoUrl: video.videoUrl,
                    duration: video.duration,
                    submodules: video.submodules.map(submodule => {
                        return {
                            title: submodule.title,
                            videoUrl: submodule.videoUrl,
                            duration: submodule.duration,

                        }
                    })
                }
            })
            console.log(videos, req.body.videos, "yes oo");

            // Validate installment settings when provided in the update. Free courses
            // cannot offer installments, so clear the flag and reset count to default if
            // the fee is being removed or set to zero.
            const updates = { ...req.body, videos };
            const updatedFee = Number(updates.fee ?? course.fee);
            if (updates.installmentsEnabled !== undefined || updates.installmentCount !== undefined) {
                if (updatedFee > 0) {
                    if (updates.installmentsEnabled !== undefined) {
                        updates.installmentsEnabled = Boolean(updates.installmentsEnabled);
                    }
                    if (updates.installmentCount !== undefined) {
                        const count = Number(updates.installmentCount);
                        if (!Number.isInteger(count) || count < 2 || count > 6) {
                            return res.status(400).json({ message: 'Installment count must be between 2 and 6' });
                        }
                        updates.installmentCount = count;
                    }
                } else {
                    updates.installmentsEnabled = false;
                    updates.installmentCount = 3;
                }
            }

            await Course.updateOne({ _id: courseId }, updates, { new: true });
            res.json({ message: 'Course updated successfully' });
        } catch (error) {
            console.error(error);
            res.status(400).json(error);
        }
    },
    notifyLive: async (req, res) => {
        const courseId = req.params.id;

        try {
            const course = await Course.findById(courseId);

            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }
            course.enrolledStudents.map(async userId => {
                await Notification.create({
                    title: "Course live",
                    content: `${course.instructorName} just went "Live" now on the course ${course.title}`,
                    contentId: course._id,
                    userId,
                });
            })
            return res.status(200).json({ message: 'Notifed students ' });
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
    },

    videoUpload: async (req, res) => {
        const courseId = req.params.courseId;

        try {
            const course = await Course.findById(courseId);
            const videos = req.body.videos
            await Promise.all(videos.map(async video => {
                try {
                    const cloudFile = await cloudinaryVidUpload(video.videoUrl)
                    course.videos = [...course.videos, {
                        title: video.title,
                        videoUrl: cloudFile
                    }]
                } catch (error) {
                    console.error(`Error uploading image ${error}`);
                }
            }))
            await course.save()
            return res.status(201).json({
                success: true,
                message: 'Videos added successfully',
                course,
            });
        } catch (error) {
            console.log(error);
            return res.status(500).json({ message: 'Unexpected error during video upload' });
        }
    },

    updateStatus: async (req, res) => {
        const courseId = req.params.courseId;
        const { id } = req.body

        try {
            const course = await Course.findById(courseId);

            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }

            // Find the student in the enrolledStudents array
            const student = course.enrollments.find(student => student.user.toString() === id);

            if (student) {
                // Update status and updatedAt fields
                student.status = 'expired';
                student.updatedAt = new Date();

                // Save the course with the updated student details
                await course.save();

                return res.status(200).json({ message: 'Status updated successfully' });
            } else {
                return res.status(404).json({ message: 'Student not found in enrolled students' });
            }
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Unexpected error during course status update' });
        }
    },

    renewCourse: async (req, res) => {
        const courseId = req.params.courseId;
        const id = req.params.id;

        try {
            const course = await Course.findById(courseId);
            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }

            const user = await User.findById(id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            if (user.blocked) {
                return res.status(403).json({ message: 'This account is not permitted to enroll' });
            }

            const enrollment = course.enrollments.find(item => String(item.user) === String(id));
            if (!enrollment) {
                return res.status(400).json({ message: 'Student is not enrolled in this course' });
            }

            // Atomic + conditional: only renew if the enrollment is not already active,
            // so repeated clicks cannot re-trigger the instructor credit below.
            const renewedAt = new Date();
            const result = await Course.updateOne(
                { _id: course._id, enrollments: { $elemMatch: { user: user._id, status: { $ne: 'active' } } } },
                {
                    $set: {
                        'enrollments.$.status': 'active',
                        'enrollments.$.enrolledOn': renewedAt,
                        'enrollments.$.updatedAt': renewedAt,
                    },
                },
            );
            if (result.modifiedCount === 0) {
                return res.status(409).json({ message: 'This enrollment is already active' });
            }

            if (course.fee > 0) {
                // creditInstructor is idempotent on txRef and uses an atomic $inc, so a
                // retried renewal cannot credit the instructor twice. The previous
                // read-modify-write (author.balance += ...) could, and did.
                try {
                    await creditInstructor(
                        {
                            courseId: course._id,
                            txRef: `renewal-${course._id}-${user._id}-${renewedAt.getTime()}`,
                        },
                        Number(course.fee),
                    );
                } catch (creditError) {
                    console.error('Renewal instructor credit failed:', creditError.message);
                }
            }

            try {
                await Notification.create({
                    title: "Course enrollment renewal",
                    content: `${user.fullname} just renewed enrollment for your course ${course.title}`,
                    contentId: course._id,
                    userId: course.instructorId,
                });
            } catch (notificationError) {
                console.error('Renewal notification failed:', notificationError.message);
            }

            return res.status(200).json({ message: 'Renewed successfully' });

        } catch (error) {
            console.error('Course renewal failed:', error);
            return res.status(500).json({ message: 'Unexpected error during renewal' });
        }
    },

    giveScholarship: async (req, res) => {
        const courseId = req.params.courseId;
        const { studentIds } = req.body;
        const grantedBy = req.user?.id || req.user?._id;

        try {
            if (!Array.isArray(studentIds) || studentIds.length === 0) {
                return res.status(400).json({ message: 'Please provide an array of student IDs' });
            }
            // Limit bulk operations to prevent accidental mass grants.
            if (studentIds.length > 100) {
                return res.status(400).json({ message: 'Cannot grant scholarships to more than 100 students at once' });
            }

            const course = await Course.findById(courseId);
            if (!course) {
                return res.status(404).json({ message: 'Course not found' });
            }
            if (!course.approved) {
                return res.status(403).json({ message: 'Cannot grant scholarships for an unapproved course' });
            }

            const students = await User.find({ _id: { $in: studentIds }, blocked: false });
            if (students.length !== studentIds.length) {
                return res.status(400).json({ message: 'One or more student IDs are invalid or blocked' });
            }

            const scholarshipResults = [];
            const failedEnrollments = [];

            for (const student of students) {
                try {
                    const alreadyEnrolled = (course.enrolledStudents || []).some(id => String(id) === String(student._id));
                    if (alreadyEnrolled) {
                        failedEnrollments.push({ studentId: student._id, reason: 'Already enrolled' });
                        continue;
                    }
                    if (course.capacity && (course.enrolledStudents || []).length >= course.capacity) {
                        failedEnrollments.push({ studentId: student._id, reason: 'Course is full' });
                        continue;
                    }

                    // Conditional atomic write: prevent two concurrent scholarship grants
                    // from both appending the same student.
                    const capacityFilter = course.capacity
                        ? { [`enrolledStudents.${course.capacity - 1}`]: { $exists: false } }
                        : {};
                    const result = await Course.updateOne(
                        { _id: course._id, enrolledStudents: { $ne: student._id }, ...capacityFilter },
                        {
                            $addToSet: { enrolledStudents: student._id },
                            $push: {
                                enrollments: {
                                    user: student._id,
                                    status: 'active',
                                    enrolledOn: new Date(),
                                    scholarship: true,
                                    grantedBy,
                                },
                            },
                        },
                    );
                    if (result.modifiedCount === 0) {
                        failedEnrollments.push({ studentId: student._id, reason: 'Concurrent enrollment or capacity reached' });
                        continue;
                    }

                    await User.updateOne({ _id: student._id }, { $set: { contact: false } });

                    try {
                        await Notification.create({
                            title: "Scholarship granted",
                            content: `You have been awarded a scholarship for ${course.title}`,
                            contentId: course._id,
                            userId: student._id,
                        });
                    } catch (notificationError) {
                        console.error('Scholarship notification failed:', notificationError.message);
                    }

                    scholarshipResults.push({ studentId: student._id, status: 'success' });
                } catch (error) {
                    console.error(`Scholarship grant failed for student ${student._id}:`, error);
                    failedEnrollments.push({ studentId: student._id, reason: error.message });
                }
            }

            // Instructor notification sent once, not per student.
            if (scholarshipResults.length > 0) {
                try {
                    await Notification.create({
                        title: "Scholarships granted",
                        content: `You granted ${scholarshipResults.length} scholarship(s) for ${course.title}`,
                        contentId: course._id,
                        userId: course.instructorId,
                    });
                } catch (notificationError) {
                    console.error('Instructor scholarship notification failed:', notificationError.message);
                }
            }

            return res.status(200).json({
                message: `Granted ${scholarshipResults.length} scholarship(s)`,
                successful: scholarshipResults,
                failed: failedEnrollments,
            });
        } catch (error) {
            console.error('Scholarship grant operation failed:', error);
            return res.status(500).json({ message: 'Scholarship operation failed. Please try again.' });
        }
    },

};



module.exports = courseController;


