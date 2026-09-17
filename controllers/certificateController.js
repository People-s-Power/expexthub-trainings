const Ceritificate = require("../models/certificate");
const Notification = require("../models/notifications.js");

const certificateController = {
  claimCetificate: async (req, res) => {
    try {
      const isRecipient = String(req.body.user) === String(req.user?.id);
      const isIssuingTutor = ['tutor', 'provider'].includes(req.user?.role)
        && String(req.body.tutor) === String(req.user?.id);
      if (!isRecipient && !isIssuingTutor && req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'You do not have permission to issue this certificate' });
      }
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
      try {
        await Notification.create({
          title: "Certificate Claimed",
          content: `You just claimed a new certificate on ${req.body.title}`,
          contentId: certificate._id,
          userId: req.body.user,
        });
      } catch (error) {
        console.error("Error creating notification:", error);
      }
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
      if (String(req.params.id) !== String(req.user?.id) && req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'You do not have permission to view these certificates' });
      }
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
      const certificate = await Ceritificate.findById(req.params.id);
      if (!certificate) return res.status(404).json({ message: 'Certificate not found' });
      if (String(certificate.user) !== String(req.user?.id) && req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'You do not have permission to delete this certificate' });
      }
      const course = await Ceritificate.deleteOne({ _id: req.params.id })
      res.json(course);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  }
}
module.exports = certificateController;
