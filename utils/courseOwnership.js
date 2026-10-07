// Which courses an account owns or is assigned to.
//
// One rule, many readers: the mailing audiences, the admissions ledger, the
// graduation verdict, the check that a tutor may only graduate a student on their
// own course, and the provider's per-course settings. They must all answer it the
// same way, and they did not.
//
// Ownership ids drifted between ObjectId and String in production — some course
// documents store `instructorId` as a plain string. `Course.aggregate` does not
// cast, so the admissions ledger, which asks through it, matches both spellings
// and sees every course. `Course.find` DOES cast the values of a query against
// the schema path, so writing `$in: [hexString, new ObjectId(hexString)]` to
// match both forms collapses to the same ObjectId twice, and MongoDB compares
// BSON types — a document storing the owner as a string can then never match.
//
// The result was two views of one audience disagreeing: a provider saw nine
// students in Admissions → My Students and two in Send Mail, both reading the
// same enrollment arrays, because the mailing audience had quietly lost the
// courses whose ownership was stored the other way. Re-deriving the fix in each
// caller is what let it happen, so the rule lives here and every reader uses it.
//
//   node scripts/courseScopeCasting.check.js
//
// proves the casting, and that this module's filter keeps both spellings.

const mongoose = require('mongoose');
const Course = require('../models/courses.js');

/**
 * A 24-hex id, and only that.
 *
 * `mongoose.Types.ObjectId.isValid` also accepts any 12-character string, which
 * it reads as 12 raw bytes. An id like that would build a filter matching
 * nothing, and "matches nothing" is a dangerous answer here: it is the difference
 * between a mailing list that is short and a graduation verdict that passes
 * vacuously. Exact matching is also what the two-spelling filter depends on.
 */
const HEX_ID = /^[0-9a-fA-F]{24}$/;

/**
 * The ownership condition, in both spellings.
 *
 * Returned as a filter fragment rather than run, because `Course.aggregate`
 * matches it directly (its `$match` is the one place casting never happens) and
 * `ownedCourseIds` hands it to the native driver unchanged.
 */
function ownershipMatch(ownerId) {
  const hex = String(ownerId || '');
  if (!HEX_ID.test(hex)) {
    throw new Error('Invalid owner id');
  }
  return {
    $or: [
      { instructorId: { $in: [hex, new mongoose.Types.ObjectId(hex)] } },
      { assignedTutors: { $in: [hex, new mongoose.Types.ObjectId(hex)] } },
    ],
  };
}

/**
 * The ids of the courses this account owns or is assigned to.
 *
 * Read through the native driver on purpose. Mongoose would cast the filter
 * against the schema and lose one of the two spellings — which is the whole
 * problem this module exists to fix — while the driver takes the filter as
 * written and still uses the `instructorId` index. The ids come back as ObjectIds
 * so the caller can load them with `.populate()` as usual.
 */
async function ownedCourseIds(ownerId) {
  return Course.collection.distinct('_id', ownershipMatch(ownerId));
}

/**
 * A `Course.find` filter for the same set, for callers that need the documents
 * themselves — populated enrollments, selected fields — rather than just ids.
 *
 * Restricting `_id` rather than repeating the ownership condition is what makes
 * this immune to the casting: `_id` is ObjectId on every document, so there is no
 * second spelling for a cast to collapse.
 */
async function ownedCourseFilter(ownerId) {
  return { _id: { $in: await ownedCourseIds(ownerId) } };
}

/**
 * The same two-spelling condition, narrowed to the courses the account *owns* —
 * `instructorId` alone, without the courses they are merely assigned to teach.
 *
 * The distinction matters wherever the question is "may this account set the
 * terms on this course" rather than "may it see the students on it". An assigned
 * tutor reads a course's roster; only the provider who owns it decides what its
 * tutors are paid. `ownershipMatch` answers the wider question and would let a
 * tutor configure the rate on a course belonging to somebody else.
 *
 * Still read through the native driver for the reason above: through
 * `Course.find` the two spellings collapse into one ObjectId and every course
 * whose owner was stored as a string disappears — which, for a settings screen,
 * means a provider cannot see or edit the rate on their own course.
 */
function authoredCourseMatch(ownerId) {
  const hex = String(ownerId || '');
  if (!HEX_ID.test(hex)) {
    throw new Error('Invalid owner id');
  }
  return { instructorId: { $in: [hex, new mongoose.Types.ObjectId(hex)] } };
}

async function authoredCourseIds(ownerId) {
  return Course.collection.distinct('_id', authoredCourseMatch(ownerId));
}

async function authoredCourseFilter(ownerId) {
  return { _id: { $in: await authoredCourseIds(ownerId) } };
}

module.exports = {
  HEX_ID,
  ownershipMatch,
  ownedCourseIds,
  ownedCourseFilter,
  authoredCourseMatch,
  authoredCourseIds,
  authoredCourseFilter,
};
