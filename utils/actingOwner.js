// Who a request is acting for.
//
// A team member keeps their own session while the dashboard shows the account
// that added them. That is the design, and it is deliberate: every privilege
// check answers from the actor's own record, so a grant can never be widened by
// switching accounts, and revoking the membership takes effect on the next
// request. The price is that the account being worked in has to travel
// separately from the actor's identity.
//
// It travels in the `X-Acting-Owner` header, set once by the client while a
// member is inside a provider's workspace. On the payment routes it instead
// arrives as `ownerId` in the query or body, which is what those screens have
// sent since they were written — both are read by the same resolver below, so
// there is one implementation of the rule rather than two that can drift.
//
// The header is a REQUEST, never an authority. It is honoured only when the
// actor's own stored record carries an accepted membership of that account
// which grants the privilege the route names. Anything else — no header, a
// header naming the actor themselves, a header naming somebody who never added
// them — resolves to the actor acting for themselves, which is precisely what
// every route did before this file existed. That property is what makes the
// change safe to apply to routes nobody has audited: forgetting to thread the
// scoper through a controller leaves a member looking at an empty scope, never
// at somebody else's data.

const mongoose = require('mongoose');
const User = require('../models/user.js');

/**
 * The header a member's client sets while working inside another account.
 *
 * Lower-case because Node lower-cases incoming header names; `req.headers` is
 * keyed that way regardless of how the client spelled it.
 */
const ACTING_OWNER_HEADER = 'x-acting-owner';

/** The default refusal, for routes that have nothing more specific to say. */
const DENIED = 'You do not have permission to perform this action';

/** The header's value as a plain string, or '' when it is absent. */
function actingOwnerHeader(req) {
  const raw = req.headers?.[ACTING_OWNER_HEADER];
  // A repeated header arrives as an array. Taking the first is the same choice
  // Express makes for every other header, and the resolver below validates it
  // either way, so a forged extra copy cannot widen anything.
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim();
}

/** True when the client has asked to act for another account at all. */
function requestsActingOwner(req) {
  return actingOwnerHeader(req) !== '';
}

/**
 * Resolve an explicit owner request against the actor's own record.
 *
 * Takes ids rather than a request so both carriers — the header and the
 * `ownerId` the payment screens send — reach the same decision by the same
 * code. `privilege` is a string from the team privilege catalogue, or null for
 * a route that has no privilege behind it; see `resolveActingOwner` for why
 * null refuses an acting member rather than allowing one.
 *
 * Returns `{ ok, status, message, caller, scoper, acting }`. `caller` is the
 * actor's stored record and `scoper` is the account whose data may be touched —
 * the owner when acting, the caller otherwise. Both are documents, because the
 * payment queries scope on `_id` in both its ObjectId and string spellings.
 */
async function resolveForOwner(actorId, requestedOwnerId, privilege, denialMessage) {
  const denial = denialMessage || DENIED;

  if (!actorId) {
    return { ok: false, status: 401, message: 'Authentication required' };
  }

  const caller = await User.findById(actorId).select('role teamMembers fullname');
  if (!caller) {
    return { ok: false, status: 401, message: 'Authentication required' };
  }

  const actorIdString = String(caller._id);
  const requested = requestedOwnerId ? String(requestedOwnerId) : '';

  // An admin already scopes the whole platform, so a header naming an account
  // could only ever narrow them. Ignoring it keeps their view unchanged rather
  // than quietly hiding rows they are entitled to see.
  const acting = requested !== '' && requested !== actorIdString && caller.role !== 'admin';

  // Not an acting request: the caller works in their own account, exactly as
  // every route behaved before this existed.
  if (!acting) {
    return { ok: true, caller, scoper: caller, acting: false };
  }

  if (!mongoose.Types.ObjectId.isValid(requested)) {
    return { ok: false, status: 400, message: 'Invalid owner id' };
  }

  // The membership is the whole authorization. There is deliberately no role
  // test here: the entry can only exist because the owner added this actor, and
  // the actor's own role is whatever category of account they signed up as —
  // an affiliate, a student, a tutor from another provider. Requiring a
  // particular role instead was why this never worked for anybody: the entry is
  // written by /auth/add-team, which grants membership to every category and
  // never rewrites the member's role, so a role test could only ever exclude.
  const entry = (caller.teamMembers || []).find(
    (candidate) =>
      String(candidate.ownerId) === requested && candidate.status === 'accepted'
  );
  if (!entry) {
    return { ok: false, status: 403, message: denial };
  }

  // A route with no privilege behind it is refused rather than guessed at. If
  // nobody has decided what grant opens a route, a member holding some other
  // grant must not be able to reach it by naming an owner.
  const granted =
    typeof privilege === 'string' &&
    privilege !== '' &&
    Array.isArray(entry.privileges) &&
    entry.privileges.some((flag) => flag.value === privilege && flag.checked);
  if (!granted) {
    return { ok: false, status: 403, message: denial };
  }

  // Read from the stored account, not the token claims, so a membership
  // revoked or a role changed after the token was issued takes effect on the
  // next request. `premiumPlan` rides along because a delegated action — sending
  // mail, most of all — is paid for by the account it is done for, and checking
  // the member's own plan would refuse exactly the delegation the grant allows.
  const owner = await User.findById(requested).select('role fullname premiumPlan');
  if (!owner) {
    return { ok: false, status: 404, message: 'Owner not found' };
  }

  return { ok: true, caller, scoper: owner, acting: true };
}

/**
 * Resolve the acting owner named by the request's `X-Acting-Owner` header.
 *
 * `privilege` should come from the team privilege catalogue. Omitting it means
 * "this route has no privilege behind it", and an acting member is then refused:
 * fail closed, so an ungated route cannot be opened by a header alone.
 */
const resolveActingOwner = (req, privilege, denialMessage) =>
  resolveForOwner(
    req.user?.id || req.user?._id,
    actingOwnerHeader(req) || null,
    privilege,
    denialMessage
  );

/**
 * The account whose data a request may touch: the acting owner when there is
 * one, otherwise the caller. Controllers scope their queries with this rather
 * than reading `req.user` directly, so a controller that is never reached by an
 * acting member behaves exactly as it did before.
 */
const scopeIdOf = (req) => req.scopeUserId || req.user?.id || req.user?._id;

module.exports = {
  ACTING_OWNER_HEADER,
  actingOwnerHeader,
  requestsActingOwner,
  resolveForOwner,
  resolveActingOwner,
  scopeIdOf,
};
