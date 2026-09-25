/**
 * URL normalisation, shared by every field that stores a link.
 *
 * `website`, an affiliate's social links and the platform's onboarding video are
 * all free text that ends up rendered as a link or an iframe `src`, and
 * `javascript:alert(1)` is a perfectly valid thing to type into a box labelled
 * "Website". React does not block a `javascript:` href for you, and neither does
 * an `<iframe src>`. So every URL is parsed and forced to http/https here, once,
 * rather than trusted at each call site.
 */

/** The default cap on a stored URL, in characters. */
const MAX_URL_LENGTH = 200;

/**
 * Normalises a user-typed URL to a safe absolute http(s) URL, or null.
 *
 * A bare `youtube.com/embed/abc` is accepted and promoted to `https://` —
 * requiring a scheme would reject the way people actually type a link. Anything
 * that parses to another scheme (javascript:, data:, file:, vbscript:) returns
 * null, so a rejected value is simply not stored rather than stored and
 * distrusted later.
 */
function normalizeUrl(value, { maxLength = MAX_URL_LENGTH, requireHost = true } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // A URL with no registrable host (`http://localhost` aside) points nowhere
    // useful. `localhost` is deliberately not special-cased: this validates what
    // a person typed into a public signup form, not a developer's test target.
    if (requireHost && !url.hostname.includes('.')) return null;
    return url.toString().slice(0, maxLength);
  } catch {
    return null;
  }
}

/** True when the value normalises to a usable http(s) URL. */
const isSafeUrl = (value, options) => normalizeUrl(value, options) !== null;

module.exports = { normalizeUrl, isSafeUrl, MAX_URL_LENGTH };
