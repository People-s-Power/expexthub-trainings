const User = require('../models/user');
const ReferralClick = require('../models/referralClick');

// Roles that are asked the referral question at signup. A provider or tutor
// signing themselves up is never asked, and neither is an affiliate — the
// question exists to attribute a *student*, and putting it to anybody else would
// create attribution where none is meaningful.
const DECLARING_ROLES = ['student', 'client'];

/**
 * Normalises the signup referral answer.
 *
 * Returns `true`, `false`, or `null` for "not answered". A form-encoded body
 * delivers the strings "true"/"false", and a client that omits the field entirely
 * delivers `undefined`; both are handled here so the controller can treat a
 * single `null` as the only "missing" case. Anything else — a stray value, an
 * empty string — is also `null`, because guessing would attribute a student to an
 * affiliate on the strength of a malformed field.
 */
function parseDeclaration(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

/**
 * Resolves an affiliate from whatever the client supplied.
 *
 * Accepts an id or a short code. The account must be a live affiliate whose
 * application is *approved*: a pending, rejected or suspended affiliate has no
 * working referral link, so accepting one here would let a student be parked
 * against an affiliate who never legitimately earned the attribution — and would
 * quietly start paying them once approved.
 *
 * Returns `{ ok: true, affiliate }` or `{ ok: false, message }`.
 */
async function resolveAffiliate({ affiliateId, affiliateCode }) {
  const query = [];
  // ObjectId shape only — a malformed id would otherwise throw a CastError.
  if (affiliateId && /^[a-f\d]{24}$/i.test(String(affiliateId))) query.push({ _id: affiliateId });
  if (affiliateCode && String(affiliateCode).trim()) query.push({ affiliateCode: String(affiliateCode).trim().toUpperCase() });
  if (!query.length) return { ok: false, message: 'Please select the affiliate who referred you' };

  const affiliate = await User.findOne({ $or: query }).select('role affiliateProfile.status email fullname');

  if (!affiliate || affiliate.role !== 'affiliate') {
    return { ok: false, message: 'We could not find that affiliate' };
  }
  if (affiliate.affiliateProfile?.status !== 'approved') {
    // One message for every non-approved state: which stage an affiliate's
    // application is at is not the student's business.
    return { ok: false, message: 'That affiliate is not currently active. Please choose another.' };
  }

  return { ok: true, affiliate };
}

/**
 * Resolves the server-side record of a referral-link click.
 *
 * The token is the authoritative signal: it was minted per click and stored
 * server-side, so it cannot be produced by guessing the affiliate's public code.
 * A token that does not resolve is treated as absent rather than as an error —
 * referral links are shared widely and an expired or hand-edited one must not be
 * able to block a signup.
 */
async function resolveLinkAttribution(referralToken) {
  if (!referralToken || typeof referralToken !== 'string') return null;

  const click = await ReferralClick.findOne({ token: referralToken }).select(
    'affiliateId code convertedUserId'
  );
  if (!click) return null;

  // Re-check standing at conversion time, not just at click time: the affiliate
  // may have been suspended in the days between the click and the signup.
  const affiliate = await User.findOne({ _id: click.affiliateId, role: 'affiliate' }).select(
    'affiliateProfile.status affiliateCode email fullname'
  );
  if (!affiliate || affiliate.affiliateProfile?.status !== 'approved') return null;

  return { click, affiliate };
}

/**
 * Decides who referred a new account, and what to record about the decision.
 *
 * Called from `register` for every signup. The shape of the answer:
 *
 *   { ok: true,  referredByAffiliate, referral }
 *   { ok: false, status, message }               — the caller returns this to the client
 *
 * Precedence runs from strongest evidence to weakest: a referral-link click
 * resolved server-side beats the student's own pick, because the link is a record
 * of an actual visit while the pick is a recollection. The declaration is still
 * stored either way, so a disagreement between the two stays auditable.
 *
 * @param {object}  params.body       raw request body
 * @param {string}  params.role       the role the account is being created with
 * @param {string}  params.email      the normalised signup email
 * @param {object}  params.registrar  the provider behind an assisted registration, or null
 */
async function resolveReferralAttribution({ body = {}, role, email, registrar }) {
  const isDeclaringRole = DECLARING_ROLES.includes(role);
  const providerAssisted = Boolean(registrar);

  // Link attribution is checked first and applies to every path — a student who
  // arrived through an affiliate's link is attributed even if they were enrolled
  // by a provider, because the click is the stronger evidence of who referred them.
  const link = await resolveLinkAttribution(body.referralToken || body.ref);

  // A provider enrolling a student is not asked the referral question, so an
  // unanswered declaration is fine there. They may still pick an affiliate
  // explicitly, which is the provider-assisted path.
  const declaration = parseDeclaration(body.isReferred);

  // The declaration only means anything for a role we actually ask, or on the
  // provider-assisted path where an affiliate may be named. Anywhere else the
  // field is ignored outright rather than honoured — a stray `isReferred: true`
  // from a client we never asked must not be able to invent an attribution.
  const declarationApplies = isDeclaringRole || providerAssisted;

  if (!declarationApplies) {
    return {
      ok: true,
      referredByAffiliate: null,
      referral: { declared: null, isReferred: null, source: null },
    };
  }

  if (isDeclaringRole && !providerAssisted && declaration === null) {
    return { ok: false, status: 400, message: 'Please tell us whether you were referred by an affiliate' };
  }

  const declaredAt = new Date();

  // --- Link wins -------------------------------------------------------------
  if (link) {
    if (String(link.affiliate.email || '').toLowerCase() === String(email || '').toLowerCase()) {
      // A self-referral through one's own link earns nothing. Unlike the
      // self-declared case this is not treated as user error — the person may
      // simply have followed their own link back to the signup page — so the
      // account is still created, just unattributed.
      return {
        ok: true,
        referredByAffiliate: null,
        referral: { declared: declaration, isReferred: false, source: 'link', affiliateCode: link.affiliate.affiliateCode, declaredAt },
      };
    }

    return {
      ok: true,
      referredByAffiliate: link.affiliate._id,
      referral: {
        declared: declaration,
        isReferred: true,
        source: 'link',
        // The affiliate's own code, so the record reads sensibly even when the
        // student also named somebody else.
        affiliateCode: link.affiliate.affiliateCode,
        declaredAt,
      },
      // Returned so the caller can mark the click converted.
      referralClickId: link.click._id,
    };
  }

  // --- Provider-assisted enrolment ------------------------------------------
  if (providerAssisted) {
    if (!body.affiliateId && !body.affiliateCode) {
      // No affiliate chosen: the student is simply this provider's enrolment.
      // Deliberately NOT auto-attributed to the provider-as-affiliate.
      return {
        ok: true,
        referredByAffiliate: null,
        referral: { declared: declaration, isReferred: declaration === true ? false : declaration, source: null, declaredAt },
      };
    }

    const resolved = await resolveAffiliate({ affiliateId: body.affiliateId, affiliateCode: body.affiliateCode });
    if (!resolved.ok) return { ok: false, status: 400, message: resolved.message };
    if (String(resolved.affiliate.email || '').toLowerCase() === String(email || '').toLowerCase()) {
      return { ok: false, status: 400, message: 'An affiliate cannot refer themselves' };
    }

    return {
      ok: true,
      referredByAffiliate: resolved.affiliate._id,
      referral: {
        declared: declaration,
        isReferred: true,
        source: 'provider_assisted',
        affiliateCode: resolved.affiliate.affiliateCode,
        declaredAt,
      },
    };
  }

  // --- The student answered "No" --------------------------------------------
  if (declaration === false) {
    return {
      ok: true,
      referredByAffiliate: null,
      referral: { declared: false, isReferred: false, source: null, declaredAt },
    };
  }

  // --- The student answered "Yes" and named an affiliate ---------------------
  const resolved = await resolveAffiliate({ affiliateId: body.affiliateId, affiliateCode: body.affiliateCode });
  if (!resolved.ok) return { ok: false, status: 400, message: resolved.message };

  // Self-referral guard. Checked against the affiliate's email, which is the only
  // identity we have before the account exists.
  if (String(resolved.affiliate.email || '').toLowerCase() === String(email || '').toLowerCase()) {
    return { ok: false, status: 400, message: 'An affiliate cannot refer themselves' };
  }

  return {
    ok: true,
    referredByAffiliate: resolved.affiliate._id,
    referral: {
      declared: true,
      isReferred: true,
      source: 'self_declared',
      affiliateCode: resolved.affiliate.affiliateCode,
      declaredAt,
    },
  };
}

/**
 * Marks a referral click as converted.
 *
 * Best-effort and idempotent: the account is already created by the time this
 * runs, so a failure here must never surface as a signup error. The conditional
 * update means a click is only ever converted once, even if two signups somehow
 * present the same token.
 */
async function markClickConverted(clickId, userId) {
  if (!clickId || !userId) return;
  try {
    await ReferralClick.updateOne(
      { _id: clickId, convertedUserId: { $exists: false } },
      { $set: { convertedUserId: userId, convertedAt: new Date() } }
    );
  } catch (error) {
    console.error('Failed to mark referral click converted:', error.message);
  }
}

module.exports = {
  resolveReferralAttribution,
  resolveAffiliate,
  resolveLinkAttribution,
  markClickConverted,
  parseDeclaration,
  DECLARING_ROLES,
};
