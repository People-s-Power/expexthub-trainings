const Ceritificate = require("../models/certificate");
const Notification = require("../models/notifications.js");
const User = require("../models/user.js");

const certificateController = {
  claimCetificate: async (req, res) => {
    try {
      // Issuing a certificate is the provider's act, not the student's. A
      // student used to be able to claim their own the moment they passed the
      // on-screen test (`isRecipient` below), which made graduation decorative:
      // the certificate could be issued without it. Now only the tutor named as
      // the certifying tutor, or an admin, may create one.
      const isIssuingTutor = ['tutor', 'provider'].includes(req.user?.role)
        && String(req.body.tutor) === String(req.user?.id);
      if (!isIssuingTutor && req.user?.role !== 'admin') {
        return res.status(403).json({
          message: 'Only the issuing tutor or an administrator can issue a certificate',
        });
      }

      // And the recipient has to have been made a graduate. This is the whole
      // point of the flag: a certificate asserts the course is finished, so
      // issuing one for a student who is still owing, or who has an assessment
      // outstanding, would make "graduate" mean nothing. Checked against the
      // stored user rather than the request, so it cannot be asserted by the
      // caller.
      const recipient = await User.findById(req.body.user).select('graduate role').lean();
      if (!recipient) {
        return res.status(404).json({ message: 'Certificate recipient not found' });
      }
      if (recipient.graduate !== true) {
        return res.status(409).json({
          message: 'This student has not been made a graduate yet. Make them a graduate first, then issue the certificate.',
          code: 'NOT_A_GRADUATE',
        });
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
      // The graduate flag comes back with the list so the download button can be
      // gated on the same fact the server enforces, rather than the page
      // inferring it from whether a certificate row happens to exist. A
      // certificate issued before this rule existed would otherwise still be
      // downloadable by a student who was never graduated.
      const [certificate, owner] = await Promise.all([
        Ceritificate.find({ user: req.params.id }).populate({
          path: 'tutor',
          select: "signature fullname _id"
        }).lean(),
        User.findById(req.params.id).select('graduate').lean(),
      ]);
      // console.log(certificate)
      return res.status(200).json({ certificate, graduate: owner?.graduate === true });
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
