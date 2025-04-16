const User = require("../models/user.js");
const { upload } = require("../config/cloudinary.js");
const createZoomMeeting = require("../utils/createZoomMeeting.js");
const LearningEvent = require("../models/event.js");
const Course = require("../models/courses.js");

const Notification = require("../models/notifications.js");
const cloudinaryVidUpload = require("../config/cloudinary.js");
const { sendEmailReminder } = require("../utils/sendEmailReminder.js");
const dayjs = require("dayjs");
const { createGoogleMeet } = require("../utils/createGoogleMeeting.js");

const eventsController = {
  createEvent: async (req, res) => {
    const { title, about, duration, type, startDate, endDate, startTime, endTime, category, mode, fee, strikedFee, days, videoUrl, timeframe, scholarship, meetingPassword, target, meetingType } = req.body;
    console.log("hmmer");

    const userId = req.params.userId;
    // Query the user database to get the user's role
    const user = await User.findById(userId);
    // Check if the user has the necessary role to add a course
    const allowedRoles = ['tutor', 'admin', 'super admin'];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(403).json({ message: 'Permission denied. Only tutors and admins can add events' });
    }
    let coursesByUser = await Course.find({
      instructorId: userId,
    });
    coursesByUser = [...coursesByUser, ...(await LearningEvent.find({
      authorId: userId,
    }))]

    if (user.role === "tutor" && ((user.premiumPlan === "basic" && coursesByUser.length >= 5) || user.premiumPlan === "standard" && coursesByUser.length >= 20)) {
      return res.status(403).json({ message: 'Your have exceeded your plan limit for  events', showPop: true });
    }
    try {
      let cloudFile
      if (req.body.asset.type === 'image') {
        const file = await upload(req.body.asset.url);
        cloudFile = file.url
      } else {
        try {
          const video = await upload.cloudinaryVidUpload(req.body.asset.url)
          cloudFile = video
        } catch (e) {
          console.log(e)
        }
      }
      const newEvent = {
        author: user.fullname,
        authorId: userId,
        title,
        about,
        duration,
        type, //online, pdf, offline, video
        startDate,
        endDate,
        startTime,
        endTime,
        category,
        mode,
        fee,
        videoUrl,
        days,
        target,
        strikedFee,
        enrolledStudents: scholarship,
        thumbnail: {
          type: req.body.asset.type,
          url: cloudFile
        },
        timeframe,
        meetingMode: meetingType
      };
      if (type === 'online') {
        if ((meetingType === "zoom") && (parseInt(duration) > parseInt(process.env.NEXT_PUBLIC_MEETING_DURATION))) {
          return res.status(400).json({ message: `Live events have a limit of ${process.env.NEXT_PUBLIC_MEETING_DURATION} minutes` });
        }
      }
      const event = await LearningEvent.create(newEvent);

      if (newEvent.type === "offline") {
        event.room = req.body.room
        event.location = req.body.location
        await event.save()
      }

      if (newEvent.type === "online") {
        //....Args -- course topic, course duration, scheduled date of the course, zoom password for course,
        if (meetingType === "google") {
          const meetingData = await createGoogleMeet(user, {
            title: event.title,
            about: event.about,
            startDate,
            endDate,
            days,
          });
          if (meetingData.success) {
            event.meetingLink = meetingData.meetLink;
            event.calendarEventId = meetingData.calendarEventId;
            await event.save()

          } else {
            return res.status(500).json({ message: meetingData.message });
          }
        } else {
          const meetingData = await createZoomMeeting(event.title, parseInt(event.duration), startDate, endDate, null, meetingPassword)
          if (meetingData.success) {
            event.meetingId = meetingData.meetingId
            event.meetingPassword = meetingData.meetingPassword
            event.zakToken = meetingData.zakToken
            await event.save()
          }
        }

      }
      const adminUsers = await User.find({ role: { $in: ["admin", "super-admin"] } });
      adminUsers.forEach(async (adminUser) => {
        try {
          await Notification.create({
            title: "Event created",
            content: `${user.fullname} just created a new event on ${event.title}`,
            contentId: event._id,
            userId: adminUser._id,
          });
        } catch (error) {
          console.error("Error creating notification:", error);
        }
      });

      return res.status(201).json({
        success: true,
        message: 'Event added successfully',
        event,
      });
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: 'Unexpected error during event creation' });
    }
  },

  getEventByCategory: async (req, res) => {
    try {
      const userId = req.params.userId

      const user = await User.findOne({ _id: userId })
      const category = [user.assignedCourse, ...user.otherCourse]

      const events = await LearningEvent.find({ category: { $in: category } }).populate({ path: 'enrolledStudents', select: "profilePicture fullname _id" }).lean();

      return res.status(200).json({ events });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error while fetching events by category' });
    }
  },

  recommend: async (req, res) => {
    const category = req.body.category;
    const userId = req.params.id;

    try {
      const events = await LearningEvent.find({ category })
      const recommendedEvent = await events.map((event) => {
        if (event.enrolledStudents.includes(userId)) {
          return null
        } else {
          return event
        }
      }).filter(item => item !== null)
      return res.status(200).json({ recommendedEvent });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error while fetching all events' });
    }
  },

  getAllEvents: async (req, res) => {
    try {
      const events = await LearningEvent.find().populate({ path: 'enrolledStudents', select: "profilePicture fullname _id" }).lean();

      return res.status(200).json({ events });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error while fetching all events' });
    }
  },

  enrollEvent: async (req, res) => {
    const eventId = req.params.eventId;
    const { id } = req.body
    try {

      const event = await LearningEvent.findById(eventId);
      const user = await User.findById(id);


      if (!event) {
        return res.status(404).json({ message: 'Event not found' });
      }

      // Check if the student is already enrolled
      if (event.enrolledStudents.includes(id)) {

        return res.status(400).json({ message: 'Student is already booked event' });
      }

      // Enroll the student in the course
      event.enrolledStudents.push(id);

      await event.save();
      await Notification.create({
        title: "Course enrolled",
        content: `${user.fullname} Just registered for your Event ${event.title}`,
        contentId: event._id,
        userId: event.authorId,
      });
      return res.status(200).json({ message: 'Booked successfully' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during booking' });
    }
  },

  getEventById: async (req, res) => {
    const eventId = req.params.eventId;

    // Validate if courseId is a valid ObjectId
    // if (!ObjectId.isValid(courseId)) {
    //     return res.status(400).json({ message: 'Invalid course ID' });
    // }

    try {
      const course = await LearningEvent.findById(eventId);
      console.log(course);

      if (!course) {
        return res.status(404).json({ message: 'Event not found' });
      }

      return res.status(200).json({ course });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error while fetching the event' });
    }
  },

  getAuthorEvent: async (req, res) => {
    const authorId = req.params.userId;
    console.log(authorId);

    try {

      const events = await LearningEvent.find({ authorId })
      console.log(events);

      return res.status(200).json({ events });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error while fetching author events' });
    }
  },
  notifyLive: async (req, res) => {
    const eventId = req.params.id;
    try {
      const event = await LearningEvent.findById(eventId);

      if (!event) {
        return res.status(404).json({ message: 'Event not found' });
      }

      event.enrolledStudents.map(async userId => {
        await Notification.create({
          title: "Course live",
          content: `${event.author} just went "Live" now on the event ${event.title}`,
          contentId: event._id,
          userId,
        });
      })
      return res.status(200).json({ message: 'Notifed students ' });
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  getEnrolledStudents: async (req, res) => {
    const courseId = req.params.courseId;

    try {
      const course = await Event.findById(courseId);

      if (!course) {
        return res.status(404).json({ message: 'Course not found' });
      }

      // Fetch details of enrolled students
      const enrolledStudents = await User.find({ _id: { $in: course.enrolledStudents } });

      if (!enrolledStudents || enrolledStudents.length === 0) {
        return res.status(404).json({ message: 'No enrolled students found for this event' });
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

  getEnrolledEvents: async (req, res) => {
    const userId = req.params.userId;

    try {
      // Find the user by ID
      // const user = await User.findById(userId);

      // if (!user) {
      //     return res.status(404).json({ message: 'User not found' });
      // }

      // Get the enrolled courses using the user's enrolledCourses array
      const enrolledCourses2 = await LearningEvent.find()
      console.log(enrolledCourses2)
      const enrolledCourses = await LearningEvent.find({ enrolledStudents: { _id: userId } }).populate({ path: 'enrolledStudents', select: "profilePicture fullname _id" }).lean();
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


  editEvent: async (req, res) => {
    try {

      const event = await LearningEvent.updateOne({
        _id: req.params.id
      }, {
        ...req.body
      }, {
        new: true
      })
      res.json(event);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  deleteEvent: async (req, res) => {
    try {
      const event = await LearningEvent.deleteOne({
        _id: req.params.id
      })
      res.json(event);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  eventReminder: async (req, res) => {
    const { userId, message, type } = req.body
    const user = await User.findOne({ _id: userId });

    try {
      await sendEmailReminder(user.email, message, type);

      res.json({
        message: "Reminder sent successfully!"
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during Reminder' });
    }
  }

}

module.exports = eventsController;
