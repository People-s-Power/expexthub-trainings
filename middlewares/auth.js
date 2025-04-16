const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
    console.log(req.headers);

    const token = req.headers.authorization || req.cookies?.accessToken;
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
