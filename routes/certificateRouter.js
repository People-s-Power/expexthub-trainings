const express = require('express');
const certificateController = require('../controllers/certificateController.js');
const authenticate = require('../middlewares/auth.js');
const { validateObjectId } = require('../middlewares/validateRequest.js');
const certificateRoute = express.Router();

certificateRoute.post('/claim', authenticate, certificateController.claimCetificate)
certificateRoute.get('/:id', authenticate, validateObjectId('id'), certificateController.getUserCetificate)
certificateRoute.delete('/delete/:id', authenticate, validateObjectId('id'), certificateController.deleteOne)


module.exports = certificateRoute;
