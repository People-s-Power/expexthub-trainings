const jwt = require('jsonwebtoken');

/**
 * Verifies the bearer token and attaches the decoded payload to req.user.
 *
 * Note: this never logs the incoming headers — doing so writes live bearer
 * tokens into application logs, where anyone with log access can replay them.
 */
const authenticate = (req, res, next) => {
    if (!process.env.JWT_SECRET) {
        console.error('JWT_SECRET is not configured; refusing to authenticate.');
        return res.status(500).json({ message: 'Server authentication is misconfigured' });
    }

    const rawToken = req.headers.authorization || req.cookies?.accessToken;
    const token = rawToken?.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            const expired = err.name === 'TokenExpiredError';
            return res.status(401).json({
                message: expired ? 'Your session has expired. Please log in again.' : 'Invalid authentication token',
                code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
            });
        }
        req.user = user;
        next();
    });
};

module.exports = authenticate;
