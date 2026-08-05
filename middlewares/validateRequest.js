const mongoose = require('mongoose');

/**
 * Rejects malformed ids before they reach Mongoose. Without this a bad id throws
 * a CastError deep in the controller and surfaces as a 500, which hides real
 * failures and makes the endpoint look broken to the client.
 */
const validateObjectId = (...names) => (req, res, next) => {
  for (const name of names) {
    const value = req.params?.[name] ?? req.body?.[name];
    if (value === undefined || value === null || value === '') continue;
    if (!mongoose.Types.ObjectId.isValid(String(value))) {
      return res.status(400).json({ message: `Invalid ${name}` });
    }
  }
  return next();
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value ?? ''));

/** Parses a positive money amount, rejecting NaN/Infinity/negative/sub-kobo noise. */
const parseAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
};

module.exports = { validateObjectId, isValidObjectId, parseAmount };
