const mongoose = require('mongoose');

/**
 * Atomic sequence allocation.
 *
 * Serial identifiers (the affiliate number `EXP-P-000125`) must not collide even
 * when two signups land in the same millisecond. Counting documents and adding
 * one is a read-then-write race; `findOneAndUpdate` with `$inc` and `upsert` is a
 * single atomic document update, so the database — not the application — decides
 * the order and no two callers can be handed the same number.
 *
 * One document per sequence, keyed by `_id` (e.g. "affiliateId").
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  // No versionKey: the counter is mutated only through atomic $inc, never saved.
  { versionKey: false }
);

const Counter = mongoose.model('Counter', counterSchema);

module.exports = Counter;
