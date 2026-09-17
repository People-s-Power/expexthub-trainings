const router = require('express').Router();
const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const partner = require('../controllers/partnerController');

router.use(authenticate, authorize('partner'));
router.get('/summary', partner.summary);
router.get('/students', partner.students);

module.exports = router;
