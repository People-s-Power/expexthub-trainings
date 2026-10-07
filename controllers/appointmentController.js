const Appointment = require("../models/appointment");
const Notification = require("../models/notifications.js");
const User = require("../models/user.js");
const createZoomMeeting = require("../utils/createZoomMeeting.js");
const mongoose = require('mongoose'); // Ensure mongoose is imported
const { sendEmailReminder } = require("../utils/sendEmailReminder.js");
const { resolveForOwner, resolveActingOwner } = require("../utils/actingOwner.js");

const appointmentControllers = {
  bookAppointment: async (req, res) => {
    try {
      const actorId = String(req.user?.id || '');
      const { to, mode, category, reason, date, time, location, room, phone } = req.body;
      if (!actorId || !to || !mode || !category || !reason || !date || !time) {
        return res.status(400).json({ message: 'Mode, category, reason, date, and time are required' });
      }
      const scheduledAt = new Date(`${date}T${time}`);
      if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
        return res.status(400).json({ message: 'Appointment must be scheduled for a future date and time' });
      }
      const user = await User.findById(actorId);
      const tutor = await User.findById(to);
      if (!user || !tutor) return res.status(404).json({ message: 'Appointment participant not found' });
      const appointment = { from: actorId, to, mode, category, reason: String(reason).trim(), date, time, location, room, phone };

      const newAppointment = await Appointment.create(appointment)
      if (newAppointment.mode === "online") {
        //....Args -- course topic, course duration, scheduled date of the course, zoom password for course,
        const meetingData = await createZoomMeeting(newAppointment.category)
        if (meetingData.success) {
          newAppointment.meetingId = meetingData.meetingId
          newAppointment.meetingPassword = meetingData.meetingPassword
          newAppointment.zakToken = meetingData.zakToken
          await newAppointment.save()
        }
      }

      try {
        await Notification.create({
          title: "Appointment Booked",
          content: `${user.fullname} just booked an appointment with you!`,
          contentId: newAppointment._id,
          userId: req.body.to,
        });
        await sendEmailReminder(tutor.email, `${user.fullname} just booked an appointment with you!`, 'Appointment',)
      } catch (error) {
        console.error("Error creating notification:", error);
      }
      return res.status(200).json({ message: 'Appointemt Created successfully', appointment: newAppointment });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during appointment processing' });
    }
  },

  getAppointments: async (req, res) => {
    try {
      const id = req.params.id
      // The id in the path is the account whose calendar is being opened, which
      // is not always the caller: a team member granted Calendar Access works
      // inside the provider's workspace, so their own token names the member
      // while the request asks for the provider's diary. The delegation resolver
      // is the one place that difference is decided — it honours the request only
      // when the member's own record carries an accepted membership granting
      // `View Calender`, and otherwise resolves to the caller acting for
      // themselves, which is exactly the check this replaced.
      const authz = await resolveForOwner(
        req.user?.id,
        id,
        'View Calender',
        'You do not have permission to view these appointments',
      )
      if (!authz.ok) return res.status(authz.status).json({ message: authz.message })

      // Read from the resolved account rather than the raw path value, so a member
      // cannot widen this by naming somebody the resolver refused.
      const ownerId = String(authz.scoper._id)

      const appointment = await Appointment.find({
        $or: [{ from: ownerId }, { to: ownerId }]
      }).populate({ path: 'from to', select: "profilePicture fullname _id" }).lean();;

      return res.status(200).json({ appointment: appointment.reverse() });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during appointment processing' });
    }
  },

  getAppointment: async (req, res) => {
    try {
      const id = req.params.id

      // Here the path names the appointment, not an account, so the account being
      // acted for can only come from the acting-owner header the client sets
      // while a member is inside a provider's workspace. With no header — every
      // ordinary request — this resolves to the caller and the participant test
      // below is the one that was here before.
      const authz = await resolveActingOwner(req, 'View Calender')
      if (!authz.ok) return res.status(authz.status).json({ message: authz.message })

      const appointment = await Appointment.findById(id).populate({ path: 'from to', select: "profilePicture fullname _id" }).lean();;
      if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

      // Either the caller or the account they are acting for has to be on the
      // appointment. A member granted Calendar Access sees the provider's diary
      // because the provider is a participant; an appointment between two other
      // people is not opened by holding the privilege.
      const allowed = [String(authz.caller._id), String(authz.scoper._id)]
      if (!allowed.includes(String(appointment.from?._id)) && !allowed.includes(String(appointment.to?._id))) {
        return res.status(403).json({ message: 'You do not have permission to view this appointment' });
      }

      return res.status(200).json({ appointment });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Unexpected error during appointment processing' });
    }
  },

  editAppointmet: async (req, res) => {
    const appointment = await Appointment.findById(req.params.id)

    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });
    if (String(appointment.from) !== String(req.user?.id) && req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Only the appointment creator can edit it' });
    }

    const user = await User.findById(appointment.from);
    const tutor = await User.findById(appointment.to);

    try {
      const updateAppointment = await Appointment.updateOne({
        _id: req.params.id
      }, {
        ...req.body
      }, {
        new: true
      })
      try {
        await Notification.create({
          title: "Appointment Updated",
          content: `${user.fullname} just updated an appointment with you!`,
          contentId: appointment._id,
          userId: appointment.to,
        });
        await sendEmailReminder(tutor.email, `${user.fullname} just updates an appointment with you!`, 'Appointment',)
      } catch (error) {
        console.error("Error creating notification:", error);
      }
      res.json(updateAppointment);
    } catch (error) {
      console.error(error);
      res.status(400).json(error);
    }
  },


  deleteAppointment: async (req, res) => {
    try {
      // Validate if the id is a valid ObjectId
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ message: 'Invalid appointment ID format' });
      }

      // Attempt to delete the appointment
    const existing = await Appointment.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Appointment not found' });
    if (String(existing.from) !== String(req.user?.id) && req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Only the appointment creator can delete it' });
    }
    const appointment = await Appointment.deleteOne({ _id: req.params.id });

      if (appointment.deletedCount === 0) {
        return res.status(404).json({ message: 'Appointment not found' });
      }

      res.json({ message: 'Appointment deleted successfully' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error', error });
    }
  },

  updateUserAvailability: async (req, res) => {
    try {
      if (String(req.params.id) !== String(req.user?.id) && req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'You do not have permission to update this availability' });
      }
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      user.days = req.body.days;
      user.mode = req.body.mode;
      user.room = req.body.room;
      user.location = req.body.location
      await user.save();

      return res.status(200).json({ message: 'Availability Added successfully!' });

    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: 'Unexpected error' });
    }
  },

  getAvailability: async (req, res) => {
    try {
      const user = await User.findById(req.params.id);

      if (!user.days && !user.mode) {
        return res.status(200).json({ message: 'User has not updated availability!' });
      } else {
        return res.status(200).json({ days: user.days, mode: user.mode, room: user.room, location: user.location });
      }

    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: 'Unexpected error' });
    }
  }
}

module.exports = appointmentControllers;
