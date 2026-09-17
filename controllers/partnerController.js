const User = require('../models/user');
const Appointment = require('../models/appointment');
const Transaction = require('../models/transactions');

const ownPartner = (req) => req.user?.role === 'partner' ? req.user.id : null;

exports.summary = async (req, res) => {
  const partnerId = ownPartner(req);
  if (!partnerId) return res.status(403).json({ message: 'Partner access required' });
  const [students, appointments, earnings] = await Promise.all([
    User.countDocuments({ registeredBy: partnerId, role: { $in: ['student', 'client'] } }),
    Appointment.countDocuments({ to: partnerId, date: { $gte: new Date().toISOString().slice(0, 10) } }),
    Transaction.aggregate([
      { $match: { userId: new (require('mongoose').Types.ObjectId)(partnerId), status: 'successful' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  res.json({ totalStudents: students, pendingAppointments: appointments, totalEarnings: earnings[0]?.total || 0 });
};

exports.students = async (req, res) => {
  const partnerId = ownPartner(req);
  if (!partnerId) return res.status(403).json({ message: 'Partner access required' });
  const students = await User.find({ registeredBy: partnerId, role: { $in: ['student', 'client'] } })
    .select('fullname email phone assignedCourse isVerified createdAt blocked').sort({ createdAt: -1 }).lean();
  res.json({ students });
};
