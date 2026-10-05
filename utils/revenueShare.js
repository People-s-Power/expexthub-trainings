/**
 * The arithmetic behind splitting a course payment.
 *
 * Two things on this platform divide the same naira and must divide it the same
 * way: the affiliate's commission, funded by the platform out of its fee, and
 * the tutor's revenue share, carved out of the provider's own net. They are
 * different deals, but both round to the kobo, both are percentages bounded by
 * the same ceiling, and both write a ledger row whose sum has to reconcile
 * against a wallet balance. Two copies of that arithmetic is how a kobo ends up
 * unaccounted for in one of them.
 *
 * Deliberately dependency-free — both the payment service and the commission
 * service require this, and the payment service already requires the commission
 * service, so anything imported here could complete a require cycle.
 */

/** Kobo in a naira. The unit every persisted money field in this app uses. */
const MINOR_UNIT = 100;

/**
 * The ceiling on any percentage this platform pays out of a payment.
 *
 * Read from MAX_REVENUE_SHARE_PERCENT, falling back to the older
 * AFFILIATE_MAX_COMMISSION_RATE name so an existing deployment keeps the ceiling
 * it configured, and to 50 so an unconfigured one still starts with a bound
 * rather than paying out an unclamped rate.
 */
function maxSharePercent() {
  const configured = Number(process.env.MAX_REVENUE_SHARE_PERCENT)
    || Number(process.env.AFFILIATE_MAX_COMMISSION_RATE);
  if (!Number.isFinite(configured) || configured <= 0) return 50;
  return configured;
}

const MAX_SHARE_PERCENT = maxSharePercent();

/**
 * A money amount rounded to the kobo.
 *
 * Half-up on the kobo, in major units. Every credit and debit this app writes is
 * built from this, because a balance that accumulates binary-float dust is a
 * balance that stops reconciling against the ledger rows that produced it.
 */
function roundMoney(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  // `value * 100` is exact for most amounts and a hair under for some: 1.005 * 100
  // is 100.49999999999999, which Math.round would take down to 1.00 — a kobo short
  // of the half-up this is documented to do, on an amount a share calculation can
  // genuinely produce. Normalising the product to twelve significant digits puts
  // the decimal's own value back before rounding. Twelve covers every amount this
  // platform can hold with kobo to spare (₦999,999,999,999 needs fourteen).
  const minor = Number((value * MINOR_UNIT).toPrecision(12));
  return Math.round(minor) / MINOR_UNIT;
}

/**
 * A percentage of an amount, in major units, rounded to the kobo.
 *
 * Returns 0 for a non-positive rate or base — a 0% share is not a rounding
 * artefact, it is "nothing is owed", and callers treat 0 as "write no row".
 */
function percentageOf(amountMajor, percent) {
  const base = Number(amountMajor);
  const rate = Number(percent);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return roundMoney((base * rate) / 100);
}

/**
 * A rate brought under the platform ceiling.
 *
 * Clamped rather than refused here, because this runs on a payment that has
 * already settled: refusing to compute would withhold money somebody has earned.
 * The settings endpoints are where an over-ceiling rate is refused outright, so
 * the only way to arrive here with one is a ceiling lowered *after* it was saved.
 *
 * A percentage ceiling does not apply to a fixed fee, which is not a proportion
 * of anything.
 */
function clampPercentage(value, ceiling = MAX_SHARE_PERCENT) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const max = Number(ceiling);
  if (!Number.isFinite(max) || max <= 0) return rate;
  return Math.min(rate, max);
}

module.exports = {
  MINOR_UNIT,
  MAX_SHARE_PERCENT,
  maxSharePercent,
  roundMoney,
  percentageOf,
  clampPercentage,
};
