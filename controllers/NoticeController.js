const User = require("../models/user")
const Notice = require("../models/notice.js");
const { upload, cloudinaryVidUpload } = require("../config/cloudinary.js");

const noticeController = {
  addNotice: async (req, res) => {
    const { title, body, role, category, country, state, link, page, cancel, action, recipient } = req.body

    if (role === 'all') {
      users = await User.find()
    } else {
      users = await User.find({ role, assignedCourse: category, state, country })
    }

    if (recipient === undefined && users.length === 0) {
      return res.status(403).json({ message: 'No user falls into the description' });
    }

    try {
      let cloudFile
      if (req.body.asset.type === 'image') {
        const file = await upload(req.body.asset.url);
        cloudFile = file
      } else {
        try {
          const video = await cloudinaryVidUpload(req.body.asset.url)
          cloudFile = video
        } catch (e) {
          console.log(e)
        }
      }

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
        thumbnail: {
          type: req.body.asset.type,
          url: cloudFile
        },
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
  },

  editNotice: async (req, res) => {
    const noticeId = req.params.noticeId;
    const updates = req.body;

    try {
      // Find the notice by ID
      const notice = await Notice.findById(noticeId);

      if (!notice) {
        return res.status(404).json({ message: 'Notice not found' });
      }

      // Only update fields that are explicitly provided in the request
      const fieldsToUpdate = ['title', 'body', 'role', 'category', 'country', 'state', 'link', 'page', 'action'];
      
      fieldsToUpdate.forEach(field => {
        if (field in updates) {
          notice[field] = updates[field];
        }
      });
      
      // Special handling for the cancel field (could be false)
      if ('cancel' in updates) {
        notice.cancel = updates.cancel;
      }
      
      // Update recipient/receivers only if explicitly provided
      if ('recipient' in updates) {
        notice.receivers = updates.recipient;
      } else if ('role' in updates) {
        // Re-fetch users based on updated criteria if role is changed
        let users = [];
        const { role } = updates;
        
        if (role === 'all') {
          users = await User.find();
        } else {
          // Only use filter criteria that are explicitly provided in the request
          const filterCriteria = { role };
          if ('category' in updates) filterCriteria.assignedCourse = updates.category;
          if ('state' in updates) filterCriteria.state = updates.state;
          if ('country' in updates) filterCriteria.country = updates.country;
          
          users = await User.find(filterCriteria);
        }
        
        if (users.length > 0) {
          notice.receivers = users;
        }
      }

      // Handle asset update ONLY if explicitly provided
      if (updates.asset) {
        let cloudFile;
        if (updates.asset.type === 'image') {
          const file = await upload(updates.asset.url);
          cloudFile = file;
        } else {
          try {
            const video = await cloudinaryVidUpload(updates.asset.url);
            cloudFile = video;
          } catch (e) {
            console.log('Video upload error:', e);
            return res.status(500).json({ message: 'Failed to upload video asset' });
          }
        }

        notice.thumbnail = {
          type: updates.asset.type,
          url: cloudFile
        };
      }

      // Save the updated notice
      await notice.save();

      return res.status(200).json({
        success: true,
        message: 'Notice updated successfully',
        notice,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during notice update' });
    }
  },

  deleteNotice: async (req, res) => {
    const noticeId = req.params.noticeId;

    try {
      // Find and delete the notice
      const result = await Notice.findByIdAndDelete(noticeId);

      if (!result) {
        return res.status(404).json({ message: 'Notice not found' });
      }

      return res.status(200).json({
        success: true,
        message: 'Notice deleted successfully'
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during notice deletion' });
    }
  }
}

module.exports = noticeController;
