const Ceritificate = require("../models/certificate");

const certificateController = {
  claimCetificate: async (req, res) => {
    try {
      // Check if the certificate already exists
      const cert = await Ceritificate.findOne({ user: req.body.user, title: req.body.title });

      if (cert) {
        return res.status(400).json({
          success: false,
          message: 'Certificate already exists!',
        });
      }

      // Create a new certificate
      const certificate = await Ceritificate.create(req.body);
      return res.status(201).json({
        success: true,
        message: 'Certificate created successfully',
        data: certificate,
      });
    } catch (error) {
      console.error('Error:', error); // More descriptive error logging
      return res.status(500).json({
        success: false,
        message: 'Unexpected error occurred!',
        error: error.message, // Provide error details for debugging
      });
    }

  },
  getUserCetificate: async (req, res) => {
    try {
      const certificate = await Ceritificate.find({ user: req.params.id }).populate({
        path: 'tutor',
        select: "signature fullname _id"
      }).lean();
      // console.log(certificate)
      return res.status(200).json({ certificate });
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: 'Unexpected error!' });
    }
  },

  deleteOne: async (req, res) => {
    try {
      const course = await Ceritificate.deleteOne({
        _id: req.params.id
      })
      res.json(course);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  }
}
module.exports = certificateController;
