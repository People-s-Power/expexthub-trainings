// Scheduled wallet payouts.
//
// Auto payout is an *additional* trigger for the existing withdrawal path, not a
// replacement for it: manual "Withdraw" still works exactly as before, and both
// go through executeWithdrawal, so a scheduled payout gets the same conditional
// debit, the same pending hold, the same webhook settlement and the same refund
// on failure. Nothing about the money logic is duplicated here.
//
// The scheduler stores an absolute `autoPayout.nextRunAt` per user rather than
// evaluating a cron rule for every wallet on every tick. That makes the sweep a
// single indexed range query, and it makes "when does mine next run?" a value the
// UI can render instead of a rule it has to re-derive.
const User = require('../models/user.js');
const { executeWithdrawal } = require('./withdrawalService.js');

// Same floor the manual endpoint enforces; a schedule cannot pay out less.
const MIN_PAYOUT = 500;
const MAX_PAYOUT = 5000000;
// How often the sweep looks for due schedules. A payout that is a few minutes
// late is fine; one that fires twice is not, which is why the claim below is a
// conditional update rather than a read-then-write.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A schedule missed while the process was down still runs, but only if it was
// due recently. Anything older is rolled forward instead — silently paying out
// a week-old schedule the moment a server comes back is a surprise, not a fix.
const MAX_CATCHUP_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  frequency: 'weekly',
  dayOfWeek: 5,
  dayOfMonth: 1,
  hour: 9,
  minute: 0,
  utcOffsetMinutes: 60,
  minimumAmount: 5000,
  maximumAmount: 0,
};

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Normalizes whatever the client sent into a schedule we are willing to store.
 * Unknown frequencies fall back to weekly rather than erroring, so a stale client
 * can never leave a wallet with a schedule the sweep cannot interpret.
 */
function normalizeSettings(input = {}, existing = {}) {
  const base = { ...DEFAULTS, ...(existing || {}) };
  const frequency = ['daily', 'weekly', 'monthly'].includes(input.frequency)
    ? input.frequency
    : (['daily', 'weekly', 'monthly'].includes(base.frequency) ? base.frequency : DEFAULTS.frequency);

  const minimumAmount = clampInt(input.minimumAmount, MIN_PAYOUT, MAX_PAYOUT, base.minimumAmount ?? DEFAULTS.minimumAmount);
  // 0 is meaningful ("sweep everything"), so it is clamped from 0 rather than MIN_PAYOUT.
  const rawMax = input.maximumAmount === '' || input.maximumAmount === null || input.maximumAmount === undefined
    ? base.maximumAmount
    : input.maximumAmount;
  let maximumAmount = clampInt(rawMax, 0, MAX_PAYOUT, base.maximumAmount ?? DEFAULTS.maximumAmount);
  // A cap below the floor would make every run a no-op; treat it as "no cap".
  if (maximumAmount > 0 && maximumAmount < minimumAmount) maximumAmount = minimumAmount;

  return {
    enabled: input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled),
    frequency,
    dayOfWeek: clampInt(input.dayOfWeek, 0, 6, base.dayOfWeek ?? DEFAULTS.dayOfWeek),
    dayOfMonth: clampInt(input.dayOfMonth, 1, 28, base.dayOfMonth ?? DEFAULTS.dayOfMonth),
    hour: clampInt(input.hour, 0, 23, base.hour ?? DEFAULTS.hour),
    minute: clampInt(input.minute, 0, 59, base.minute ?? DEFAULTS.minute),
    utcOffsetMinutes: clampInt(input.utcOffsetMinutes, -720, 840, base.utcOffsetMinutes ?? DEFAULTS.utcOffsetMinutes),
    minimumAmount,
    maximumAmount,
  };
}

/**
 * The next UTC instant this schedule fires, strictly after `from`.
 *
 * The user picks a day and time in their own zone, so the arithmetic is done on a
 * shifted clock (UTC + offset) and shifted back at the end. A fixed offset is
 * correct for WAT, which has no DST; a zone that does would need a tz database
 * rather than a stored offset.
 */
function computeNextRunAt(settings, from = new Date()) {
  const s = normalizeSettings(settings, settings);
  const offsetMs = s.utcOffsetMinutes * 60 * 1000;
  // "Local" here means a Date whose UTC getters read as the user's wall clock.
  const local = new Date(from.getTime() + offsetMs);

  const candidate = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    s.hour,
    s.minute,
    0,
    0,
  ));

  if (s.frequency === 'daily') {
    if (candidate <= local) candidate.setUTCDate(candidate.getUTCDate() + 1);
  } else if (s.frequency === 'weekly') {
    const delta = (s.dayOfWeek - candidate.getUTCDay() + 7) % 7;
    candidate.setUTCDate(candidate.getUTCDate() + delta);
    if (candidate <= local) candidate.setUTCDate(candidate.getUTCDate() + 7);
  } else {
    candidate.setUTCDate(s.dayOfMonth);
    if (candidate <= local) candidate.setUTCMonth(candidate.getUTCMonth() + 1, s.dayOfMonth);
  }

  return new Date(candidate.getTime() - offsetMs);
}

/** The stored shape plus the derived next run, ready to persist. */
function buildAutoPayoutUpdate(input, existing) {
  const settings = normalizeSettings(input, existing);
  return {
    ...settings,
    nextRunAt: settings.enabled ? computeNextRunAt(settings) : null,
  };
}

/** What the wallet UI renders. Never leaks anything the owner cannot already see. */
function serializeAutoPayout(user) {
  const raw = user?.autoPayout || {};
  const settings = normalizeSettings(raw, raw);
  return {
    ...settings,
    nextRunAt: raw.nextRunAt || null,
    lastRunAt: raw.lastRunAt || null,
    lastStatus: raw.lastStatus || null,
    lastMessage: raw.lastMessage || null,
    lastAmount: raw.lastAmount ?? null,
  };
}

/**
 * Runs one user's scheduled payout and rolls their schedule forward.
 *
 * The slot is always advanced, including when the run is skipped or fails, so a
 * wallet that is short on funds waits for its next slot instead of being retried
 * every five minutes.
 */
async function runOneSchedule(user) {
  const settings = normalizeSettings(user.autoPayout, user.autoPayout);
  const nextRunAt = computeNextRunAt(settings);
  const finish = (lastStatus, lastMessage, lastAmount = null) => User.updateOne(
    { _id: user._id },
    {
      $set: {
        'autoPayout.lastRunAt': new Date(),
        'autoPayout.lastStatus': lastStatus,
        'autoPayout.lastMessage': lastMessage,
        'autoPayout.lastAmount': lastAmount,
        'autoPayout.nextRunAt': nextRunAt,
      },
    },
  ).then(() => ({ userId: String(user._id), status: lastStatus, message: lastMessage, amount: lastAmount }));

  if (!user.bankCode || !user.accountNumber) {
    return finish('skipped', 'No payout bank account saved');
  }

  const balance = Number(user.balance || 0);
  const floor = Math.max(MIN_PAYOUT, Number(settings.minimumAmount || MIN_PAYOUT));
  if (balance < floor) {
    return finish('skipped', `Balance below the ${floor} minimum`);
  }

  const cap = Number(settings.maximumAmount || 0) > 0 ? Number(settings.maximumAmount) : balance;
  // Whole naira only: the gateway rejects fractional transfer amounts.
  const amount = Math.floor(Math.min(balance, cap, MAX_PAYOUT));
  if (amount < MIN_PAYOUT) {
    return finish('skipped', `Payable amount below the ${MIN_PAYOUT} minimum`);
  }

  try {
    const result = await executeWithdrawal({
      user,
      amount,
      source: 'auto_payout',
      narration: 'Scheduled payout',
    });
    if (result.outcome === 'successful') return finish('successful', 'Payout completed', amount);
    if (result.outcome === 'queued') return finish('queued', 'Payout queued at the bank', amount);
    return finish('failed', result.message || 'Payout could not be completed');
  } catch (error) {
    console.error('Auto payout failed:', error.message);
    return finish('failed', 'Payout could not be completed');
  }
}

/**
 * Sweeps every schedule that has come due.
 *
 * Each user is claimed with a conditional update that moves `nextRunAt` forward
 * before any money moves, so two overlapping sweeps (or two processes) cannot
 * both pay out the same slot — the loser's update matches nothing and it skips.
 */
async function runDueAutoPayouts({ limit = 200 } = {}) {
  const now = new Date();
  const due = await User.find({
    'autoPayout.enabled': true,
    'autoPayout.nextRunAt': { $ne: null, $lte: now },
  }).limit(limit);

  const results = [];
  for (const user of due) {
    const scheduledFor = user.autoPayout?.nextRunAt;
    // Claim the slot. Matching on the exact nextRunAt we read is the lock.
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, 'autoPayout.nextRunAt': scheduledFor },
      { $set: { 'autoPayout.nextRunAt': new Date(now.getTime() + SWEEP_INTERVAL_MS * 2) } },
    );
    if (!claimed) continue;

    // Too far behind to be meaningful — roll forward without paying out.
    if (now.getTime() - new Date(scheduledFor).getTime() > MAX_CATCHUP_MS) {
      const settings = normalizeSettings(user.autoPayout, user.autoPayout);
      await User.updateOne(
        { _id: user._id },
        { $set: { 'autoPayout.nextRunAt': computeNextRunAt(settings), 'autoPayout.lastStatus': 'skipped', 'autoPayout.lastMessage': 'Missed schedule rolled forward' } },
      );
      continue;
    }

    results.push(await runOneSchedule(user));
  }

  if (results.length) {
    const paid = results.filter((r) => r.status === 'successful' || r.status === 'queued').length;
    console.log(`Auto payout sweep: ${results.length} due, ${paid} paid out.`);
  }
  return results;
}

let sweepTimer = null;

/** Starts the recurring sweep. Safe to call once at boot; repeat calls are no-ops. */
function startAutoPayouts({ intervalMs = SWEEP_INTERVAL_MS } = {}) {
  if (sweepTimer) return sweepTimer;
  const tick = () => {
    runDueAutoPayouts().catch((error) => console.error('Auto payout sweep failed:', error.message));
  };
  // Delay the first tick so a boot loop cannot hammer the gateway.
  setTimeout(tick, 60 * 1000).unref?.();
  sweepTimer = setInterval(tick, intervalMs);
  sweepTimer.unref?.();
  console.log('Auto payout scheduler started.');
  return sweepTimer;
}

module.exports = {
  MIN_PAYOUT,
  MAX_PAYOUT,
  SWEEP_INTERVAL_MS,
  normalizeSettings,
  computeNextRunAt,
  buildAutoPayoutUpdate,
  serializeAutoPayout,
  runDueAutoPayouts,
  startAutoPayouts,
};
