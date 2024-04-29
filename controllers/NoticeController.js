const User = require("../models/user")
const upload = require("../config/cloudinary.js");
const Notice = require("../models/notice.js");

const noticeController = {
  addNotice: async (req, res) => {
    const { title, body, role, category, country, state, link, page, cancel, action, recipient } = req.body

    users = await User.find({ role, assignedCourse: category, state, country })

    if (users.length === 0 || recipient === undefined) {
      return res.status(403).json({ message: 'No user falls into the description' });
    }

    try {
      // const cloudFile = await upload(req.body.image);

      const newNotice = {
        title,
        body,
        role,
        category,
        country,
        state,
        link,
        page,
        cancel,
        action,
        // image: cloudFile,
        receivers: recipient ? recipient : users
      }

      const notice = await Notice.create(newNotice)

      return res.status(201).json({
        success: true,
        message: 'Notice created successfully',
        notice,
      });
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  },
  getAllNotice: async (req, res) => {
    try {
      notice = await Notice.find()
      return res.status(200).json({ notice })
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  },
  getAssignedNotice: async (req, res) => {
    const userId = req.params.userId;

    try {
      notice = await Notice.find({
        receivers: { _id: userId }, viewed: {
          $not: {
            $elemMatch: {
              $eq: userId
            }
          }
        }
      })
      return res.status(200).json({ notice })

    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  },
  markViewed: async (req, res) => {
    const noticeId = req.params.noticeId;

    const { id } = req.body

    try {

      const notice = await Notice.findById(noticeId);
      const user = await User.findById(id);

      if (!notice) {
        return res.status(404).json({ message: 'Notice not found' });
      }

      // Check if the student is already enrolled
      if (notice.viewed.includes(id)) {
        return res.status(400).json({ message: 'Student has already viewed this notice' });
      }

      // Enroll the student in the course
      notice.viewed.push(id);
      await notice.save();

      return res.status(200).json({ message: 'Viewed successfully' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  }
}

module.exports = noticeController;
