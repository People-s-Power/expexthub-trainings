const mongoose = require('mongoose');
const appointmentSchema = new mongoose.Schema(
  {
    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    mode: {
      type: String,
      required: true
    },
    category: {
      type: String,
      required: true
    },
    reason: {
      type: String,
      required: false
    },
    title: {
      type: String,
      required: false
    },
    // Calendar-facing lifecycle (spec §14/§15). Every value is optional with a
    // default so rows written before these fields existed still load and simply
    // read as `pending` rather than failing validation.
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'completed', 'cancelled', 'rescheduled', 'no_show'],
      default: 'pending',
      index: true,
    },
    // 'date' is the day the appointment sits on (kept a String for backwards
    // compatibility with existing rows and the current UI); these carry the precise
    // window so a day/week view can place the block without reparsing free text.
    startTime: { type: String, required: false },
    endTime: { type: String, required: false },
    meetingType: {
      type: String,
      enum: ['virtual', 'physical', 'phone', null],
      default: null,
    },
    meetingLink: { type: String, required: false },
    notes: { type: String, required: false },
    // Set when a reminder has been dispatched, so a sweep that runs repeatedly
    // sends one reminder per appointment instead of one per run.
    reminderSentAt: { type: Date, required: false },
    // Why a declined or moved appointment changed state, shown to both parties.
    cancellationReason: { type: String, required: false },
    rescheduledFrom: { type: Date, required: false },
    date: {
      type: String,
      required: false
    },
    time: {
      type: String,
      required: false
    },
    location: String,
    room: String,
    phone: String,
    meetingId: String,
    meetingPassword: String,
    zakToken: String,
  },
  { timestamps: true }
)

// The calendar screens read one participant's appointments over a date range.
appointmentSchema.index({ to: 1, date: 1 });
appointmentSchema.index({ from: 1, date: 1 });

const Appointment = mongoose.model('Appointment', appointmentSchema);

module.exports = Appointment;
