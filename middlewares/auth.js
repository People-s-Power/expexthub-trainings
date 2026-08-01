const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
    console.log(req.headers);

    const rawToken = req.headers.authorization || req.cookies?.accessToken;
    const token = rawToken?.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;
    if (token) {
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) {
                return res.sendStatus(403); // Forbidden
            }
            req.user = user;
            next();
        });
    } else {
        res.sendStatus(401); // Unauthorized
    }
};

module.exports = authenticate;
