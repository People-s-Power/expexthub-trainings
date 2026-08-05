/**
 * Dependency-free fixed-window rate limiter.
 *
 * Deliberately has no external dependency so it cannot fail at require-time on a
 * deploy that skipped `npm install`. State is per-process: with more than one
 * instance behind a load balancer each process keeps its own counters, so the
 * effective limit is `max * instanceCount`. That is acceptable as an abuse
 * brake; move to a shared Redis store if you need an exact global limit.
 */

const WINDOW_SWEEP_MS = 60 * 1000;

function createRateLimiter({ windowMs, max, message, keyGenerator }) {
  const hits = new Map();

  // Drop expired buckets so the map cannot grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }, WINDOW_SWEEP_MS);
  if (typeof sweep.unref === 'function') sweep.unref();

  const defaultKey = (req) => req.user?.id || req.user?._id || req.ip;

  return (req, res, next) => {
    const key = String((keyGenerator || defaultKey)(req) || 'anonymous');
    const now = Date.now();
    let bucket = hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil((bucket.resetAt - now) / 1000));

    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ message });
    }

    return next();
  };
}

// Starting a checkout is expensive (creates a Transaction + hits Flutterwave),
// so it gets a tighter budget than ordinary reads.
const paymentLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many payment attempts. Please wait a few minutes and try again.',
});

// Wallet spend and withdrawal move real money — keep these strict.
const walletLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many wallet operations. Please wait a few minutes and try again.',
});

const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests. Please try again later.',
});

module.exports = { createRateLimiter, paymentLimiter, walletLimiter, generalLimiter };
