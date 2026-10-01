const { requestsActingOwner, resolveActingOwner, scopeIdOf } = require('../utils/actingOwner.js');

/**
 * The gate for the tutor workspace's routes, in place of `authorize(...TUTOR_*)`.
 *
 * It admits exactly the roles `authorize` admitted, and one more audience: a
 * member of a provider's team who is working inside that provider's workspace.
 * The member's own role is whatever category of account they signed up as — an
 * affiliate, most often — so a role list can never admit them, which is why
 * every one of these routes answered 403 no matter what the provider granted.
 *
 * `privilege` names the grant the route needs, from the team privilege
 * catalogue. Omitting it means the route has no privilege behind it, and an
 * acting member is refused: a route nobody has decided how to gate must not be
 * opened by a header alone.
 *
 * Two properties make this safe to put in front of routes that have not been
 * audited individually:
 *
 *   - A request carrying no acting header is decided entirely in memory by the
 *     same role check `authorize` performed, so it costs nothing extra and
 *     behaves identically. The database is only consulted when a client has
 *     actually asked to act for another account.
 *
 *   - The caller's session is never rewritten. `req.user` stays the actor's, so
 *     every privilege check — and every audit entry — still answers from the
 *     person who made the request. The account being worked in is published
 *     separately as `req.scopeUserId`, which controllers scope their queries
 *     with. A controller that forgets to read it returns the actor's own
 *     (almost always empty) scope rather than another account's data.
 */
const tutorSurface = (roles, privilege) => async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    if (requestsActingOwner(req)) {
      const authz = await resolveActingOwner(req, privilege);
      if (!authz.ok) {
        return res.status(authz.status).json({ message: authz.message });
      }

      if (authz.acting) {
        req.actingOwner = authz.scoper;
        req.scopeUserId = String(authz.scoper._id);
        return next();
      }

      // A header naming nobody, or naming the caller's own account, is not an
      // acting request. Fall through to the ordinary role check rather than
      // skipping it — otherwise any account could clear this gate by sending
      // its own id in the header.
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action' });
    }

    req.actingOwner = null;
    req.scopeUserId = String(scopeIdOf(req));
    return next();
  } catch (error) {
    // Express 4 does not catch a rejected promise from a middleware, so an
    // unreachable database would otherwise hang the request instead of failing
    // it. Refusing is the only safe answer: this gate decides whose data a
    // request may touch.
    console.error('Acting owner check failed:', error);
    return res.status(500).json({ message: 'Unable to verify your access' });
  }
};

module.exports = tutorSurface;
