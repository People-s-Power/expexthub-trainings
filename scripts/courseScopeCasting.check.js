// Prove that ownership scoping can see both id spellings — and that the rule the
// four readers now share is the one that does it.
//
// A course's `instructorId` / `assignedTutors` are ObjectId-typed, and some
// production documents stored the owner as a plain string instead. Mongoose casts
// the values of a query against the schema path, so the two-spelling `$in` that
// was meant to cover both collapses into the same ObjectId twice; MongoDB
// compares BSON types, so the string-stored courses became unreachable. That is
// how a provider came to see nine students in Admissions → My Students and two in
// Send Mail from the same enrollment arrays.
//
//   node scripts/courseScopeCasting.check.js
//
// No database and no network: casting is a local operation on a query, and the
// one call that would reach the driver is stubbed so the filter it would receive
// can be inspected.
const mongoose = require('mongoose');
const Course = require('../models/courses.js');
const {
  ownershipMatch,
  ownedCourseIds,
  ownedCourseFilter,
} = require('../utils/courseOwnership.js');

const HEX = '507f1f77bcf86cd799439011';
const formOf = (value) => (value instanceof mongoose.Types.ObjectId ? 'ObjectId' : typeof value);

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

const formsIn = (filter) =>
  filter.$or.map((clause) => formOf(Object.values(clause)[0].$in[0])).join(',');

// --- the mechanism -----------------------------------------------------------
// Written the way the old code wrote it: the hex string was there to reach a
// string-stored owner, and Course.find takes it away.
const handWritten = {
  $or: [
    { instructorId: { $in: [HEX, new mongoose.Types.ObjectId(HEX)] } },
    { assignedTutors: { $in: [HEX, new mongoose.Types.ObjectId(HEX)] } },
  ],
};
const castForms = handWritten.$or.map(
  (clause) => Course.find(clause).cast(Course)[Object.keys(clause)[0]].$in.map(formOf).join('/')
);

console.log(`a hand-written filter through Course.find: ${castForms.join(', ')}`);
console.log(`the shared rule, uncast:                   ${formsIn(ownershipMatch(HEX))}\n`);

check(
  'the shared rule keeps both spellings, so either storage form can match',
  formsIn(ownershipMatch(HEX)) === 'string,string',
  `it produced ${formsIn(ownershipMatch(HEX))}`
);
check(
  'the same filter written by hand loses a spelling the moment Mongoose casts it',
  castForms.every((form) => form === 'ObjectId/ObjectId'),
  `it survived as ${castForms.join(', ')}`
);

// An id Mongoose would accept but MongoDB would never match. Treating it as
// valid is the dangerous direction: no courses reads as nothing outstanding, and
// a graduation verdict then passes vacuously.
check(
  'a 12-character id is refused rather than read as 12 raw bytes',
  (() => {
    try {
      ownershipMatch('abcdefghijkl');
      return false;
    } catch {
      return true;
    }
  })(),
  'it was accepted, so the filter would match nothing and read as "no courses"'
);
check(
  'an empty owner is refused',
  (() => {
    try {
      ownershipMatch('');
      return false;
    } catch {
      return true;
    }
  })()
);

// --- the readers -------------------------------------------------------------
// The driver takes the filter as written, which is the whole point of asking it
// rather than Mongoose. Capture what it would be handed.
let handedToDriver = null;
const realDistinct = Course.collection.distinct;
Course.collection.distinct = async (field, filter) => {
  handedToDriver = { field, filter };
  return [new mongoose.Types.ObjectId(HEX)];
};

const main = async () => {
  const ids = await ownedCourseIds(HEX);

  check(
    'the ids are read through the driver, which keeps both spellings',
    Boolean(handedToDriver) && formsIn(handedToDriver.filter) === 'string,string',
    handedToDriver ? `it was handed ${formsIn(handedToDriver.filter)}` : 'the driver was not called'
  );
  check(
    'it asks for _id and nothing else',
    handedToDriver?.field === '_id',
    `it asked for ${handedToDriver?.field}`
  );

  // The filter the callers actually query with names `_id`, which is ObjectId on
  // every document — so there is no second spelling left for a cast to collapse,
  // and `Course.find` can be used safely from here on.
  const filter = await ownedCourseFilter(HEX);
  const cast = Course.find(filter).cast(Course);
  const castIds = cast._id.$in.map(formOf);

  check(
    'the filter the callers query with collapses to nothing — it is all ObjectId',
    castIds.every((form) => form === 'ObjectId'),
    `it became ${castIds.join(', ')}`
  );
  check(
    'it carries the ids the driver returned',
    cast._id.$in.length === ids.length && String(cast._id.$in[0]) === String(ids[0]),
    `it carried ${cast._id.$in.map(String).join(', ')}`
  );

  Course.collection.distinct = realDistinct;

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('ownership scoping reaches both id spellings');
};

main();
