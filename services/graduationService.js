// Whether a student has earned the graduate flag.
//
// Two questions, and both have to be yes:
//
//  1. Is every one of the courses they are being graduated from fully paid?
//  2. Has every assessment assigned to them been passed?
//
// The answers are gathered here rather than inside the controller because the
// rule is now the only thing standing between a student and a certificate, and
// it needs to be testable and readable on its own. The judgement itself is pure
// (`utils/graduation.js`); this file only fetches the inputs.
const mongoose = require('mongoose');
const Course = require('../models/courses.js');
const Transaction = require('../models/transactions.js');
const CoursePaymentPlan = require('../models/coursePaymentPlans.js');
const Assessment = require('../models/assessment.js');
const {
  FULL_PAYMENT_TYPES,
  summarizeEnrollmentPaid,
} = require('./coursePaymentService.js');
const {
  summarizeAssessments,
  passMarkPercent,
  graduationRefusalMessage,
} = require('../utils/graduation.js');

/**
 * Matches a stored `courseId` against a list of ids, whatever BSON type each
 * side happens to be.
 *
 * Course ids drifted between ObjectId and string across this data set (the same
 * drift `courseScopeFor` and the payment pipeline both work around), and a plain
 * `$in` against an ObjectId-typed path is cast before it reaches Mongo, so it can
 * only ever match the ObjectId half. Comparing both sides as strings is the one
 * form that matches either.
 */
function courseIdIn(courseIds) {
  return { $in: [{ $toString: '$courseId' }, courseIds.map(String)] };
}

const studentIdIs = (studentId) => ({ $eq: [{ $toString: '$userId' }, String(studentId)] });

/**
 * The money events behind a set of courses for one student.
 *
 * Returns `{ latestPlan, fullPaidByCourse }`, both keyed by stringified course
 * id — the live plan per course, and the total of settled full payments.
 *
 * These are the same inputs the admissions payment table is built from, read
 * through the same `FULL_PAYMENT_TYPES` list and the same
 * `summarizeEnrollmentPaid` rule, so a provider cannot be refused graduation for
 * a student whose row on that table reads as settled.
 */
async function paymentStanding(courseIds, studentId) {
  if (!courseIds.length) return [];

  const [planRows, paymentRows] = await Promise.all([
    CoursePaymentPlan.find({
      status: { $ne: 'cancelled' },
      $expr: { $and: [courseIdIn(courseIds), studentIdIs(studentId)] },
    })
      .select('courseId totalAmountMinor amountPaidMinor updatedAt')
      .lean(),
    Transaction.find({
      status: 'successful',
      type: { $in: FULL_PAYMENT_TYPES },
      $expr: { $and: [courseIdIn(courseIds), studentIdIs(studentId)] },
    })
      .select('courseId amount')
      .lean(),
  ]);

  // The live plan per course: a student who abandoned one plan and opened
  // another has two documents, and the newest is the one they are being held to.
  // Chosen here rather than in the query because `$group` after `$sort` leaves
  // the winner's identity to the server's grouping order.
  const latestPlan = new Map();
  planRows.forEach((row) => {
    const key = String(row.courseId);
    const current = latestPlan.get(key);
    if (!current || new Date(row.updatedAt) > new Date(current.updatedAt)) latestPlan.set(key, row);
  });

  const fullPaidByCourse = new Map();
  paymentRows.forEach((row) => {
    const key = String(row.courseId);
    fullPaidByCourse.set(key, (fullPaidByCourse.get(key) || 0) + (Number(row.amount) || 0));
  });

  return { latestPlan, fullPaidByCourse };
}

/**
 * The graduation verdict for one student.
 *
 * Returns `{ eligible, unpaidCourses, assessments, message }`. `message` is null
 * when eligible, and otherwise says which requirement is short.
 */
async function evaluateGraduation({ studentId, actorId, isAdmin = false }) {
  if (!mongoose.Types.ObjectId.isValid(String(studentId))) {
    throw new Error('Invalid student id');
  }

  // An admin graduates platform-wide; a provider graduates for their own
  // courses. `$and` rather than a spread, because both halves carry their own
  // `$or` and the second would silently replace the first.
  const ownership = isAdmin ? {} : {
    $or: [
      { instructorId: { $in: [actorId, String(actorId)] } },
      { assignedTutors: { $in: [actorId, String(actorId)] } },
    ],
  };

  const courses = await Course.find({
    $and: [
      ownership,
      { $or: [{ enrolledStudents: studentId }, { 'enrollments.user': studentId }] },
    ],
  })
    .select('title fee enrollments')
    .lean();

  const courseIds = courses.map((course) => course._id);
  const standing = await paymentStanding(courseIds, studentId);

  const unpaidCourses = [];
  if (courseIds.length) {
    const { latestPlan, fullPaidByCourse } = standing;

    for (const course of courses) {
      const key = String(course._id);
      const enrollment = (course.enrollments || [])
        .find((entry) => String(entry.user) === String(studentId));
      const plan = latestPlan.get(key) || null;

      const summary = summarizeEnrollmentPaid({
        // `scholarship` is a property of the seat, so a scholarship student is
        // settled by definition rather than owing the fee with no way to pay it.
        scholarship: enrollment?.scholarship === true || enrollment?.status === 'scholarship',
        planTotalMinor: plan?.totalAmountMinor || 0,
        planPaidMinor: plan?.amountPaidMinor || 0,
        fullPaidMajor: fullPaidByCourse.get(key) || 0,
        feeMajor: course.fee,
      });

      if (!summary.settled) {
        unpaidCourses.push({
          courseId: key,
          title: course.title || 'Untitled course',
          expected: summary.expected,
          paid: summary.paid,
          owed: summary.owed,
        });
      }
    }
  }

  const assessments = await Assessment.find({ assignedStudents: studentId })
    .select('title assesment responses')
    .lean();

  const mark = passMarkPercent();
  const assessmentStanding = summarizeAssessments(assessments, studentId, mark);

  const eligible = unpaidCourses.length === 0 && assessmentStanding.allPassed;

  return {
    eligible,
    unpaidCourses,
    assessments: assessmentStanding,
    message: eligible
      ? null
      : graduationRefusalMessage({
        unpaidCourses,
        assessments: assessmentStanding.outstanding,
      }),
  };
}

module.exports = {
  evaluateGraduation,
  paymentStanding,
};
