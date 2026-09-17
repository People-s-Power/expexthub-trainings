const express = require('express');
const appointmentControllers = require('../controllers/appointmentController')
const authenticate = require('../middlewares/auth.js');
const { validateObjectId } = require('../middlewares/validateRequest.js');
const appointmentRouter = express.Router();

appointmentRouter.post('/new', authenticate, appointmentControllers.bookAppointment)
appointmentRouter.get('/:id', authenticate, validateObjectId('id'), appointmentControllers.getAppointments)
appointmentRouter.put('/edit-appointment/:id', authenticate, validateObjectId('id'), appointmentControllers.editAppointmet)
appointmentRouter.delete('/delete/:id', authenticate, validateObjectId('id'), appointmentControllers.deleteAppointment)

appointmentRouter.put('/availability/:id', authenticate, validateObjectId('id'), appointmentControllers.updateUserAvailability)
appointmentRouter.get('/availability/:id', authenticate, validateObjectId('id'), appointmentControllers.getAvailability)
appointmentRouter.get('/single/:id', authenticate, validateObjectId('id'), appointmentControllers.getAppointment)



module.exports = appointmentRouter;
