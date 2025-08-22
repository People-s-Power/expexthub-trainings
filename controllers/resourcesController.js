const { upload } = require("../config/cloudinary.js");
const Resource = require("../models/resources.js");
const Course = require("../models/courses.js");
const { cloudinaryVidUpload } = require("../config/cloudinary.js");

const resourceController = {
  addCourseResources: async (req, res) => {
    const { title, type, websiteUrl, aboutCourse, assignedCourse } = req.body;
    console.log(req.files)
    try {
      // Handle image upload from req.files
      let cloudFile;
      if (req.files && req.files.image) {
        cloudFile = await upload(req.files.image.tempFilePath);
      }

      let file;

      if (type === 'video' && req.files && req.files.video) {
        file = await cloudinaryVidUpload(req.files.video.tempFilePath);
      }
      if (type === 'pdf' && req.files && req.files.pdf) {
        file = await upload(req.files.pdf.tempFilePath);
      }
      if (type === 'link') {
        file = websiteUrl;
      }

      // Create a new resource
      const newResource = {
        title,
        websiteUrl: file,
        aboutCourse,
        image: cloudFile,
        assignedCourse,
        type
      };

      const resource = await Resource.create(newResource);

      return res.status(201).json({ message: 'Resource added successfully', resource });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during resource addition' });
    }
  },

  getResources: async (req, res) => {
    try {
      const resource = await Resource.find();

      return res.status(200).json({ resource });
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  getAssignedResources: async (req, res) => {
    const id = req.params.id
    try {
      const resource = await Resource.find({ assignedCourse: id });

      return res.status(200).json({ resource });
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  editResource: async (req, res) => {
    try {
      const resource = await Resource.updateOne({
        _id: req.params.id
      }, {
        ...req.body
      }, {
        new: true
      })
      res.json(resource);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  deleteResource: async (req, res) => {
    try {
      const resource = await Resource.deleteOne({
        _id: req.params.id
      })
      res.json(resource);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },

  getTutorResources: async (req, res) => {
    const userId = req.params.tutorId;
    try {
      // Fetch all courses
      const courses = await Course.find();
      if (!courses || courses.length === 0) {
        return res.status(404).json({ message: 'No courses found' });
      }

      // Filter courses by instructorId or assignedTutors
      const filteredCourses = courses.filter(course => (
        course.instructorId?.toString() === userId ||
        (Array.isArray(course.assignedTutors) && course.assignedTutors.map(id => id.toString()).includes(userId))
      ));

      if (filteredCourses.length === 0) {
        return res.status(404).json({ message: 'No courses found for this tutor' });
      }

      // Extract course IDs
      const courseIds = filteredCourses.map(course => course._id.toString());

      // Find all resources assigned to these courses
      const resources = await Resource.find({ assignedCourse: { $in: courseIds } });

      return res.status(200).json({ 
        message: 'Tutor resources retrieved successfully',
        resources,
        totalResources: resources.length
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during resource retrieval' });
    }
  },
}

module.exports = resourceController;
