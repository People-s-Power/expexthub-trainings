const express = require('express');
const eventsController = require('../controllers/eventsController.js');
const authenticate = require('../middlewares/auth.js');
const { validateObjectId } = require('../middlewares/validateRequest.js');

const eventRouter = express.Router();

eventRouter.post("/add-event/:userId", eventsController.createEvent);

// One account's enrolled events, with the enrolled students populated. This is
// the only route on this router with a session in front of it: the id in the path
// used to be the whole authorization, so anyone could read any account's
// participant list. The rest of this router is still open and wants auditing —
// this one is fixed because the calendar reads it.
eventRouter.get(
  "/my-events/:userId",
  authenticate,
  validateObjectId('userId'),
  eventsController.getEnrolledEvents
);

eventRouter.get("/category/:userId", eventsController.getEventByCategory)
eventRouter.get("/author/:userId", eventsController.getAuthorEvent)

eventRouter.get("/all", eventsController.getAllEvents)

eventRouter.put("/enroll/:eventId", eventsController.enrollEvent)

eventRouter.put("/edit/:id", eventsController.editEvent)

eventRouter.put("/recommend/:id", eventsController.recommend)

eventRouter.get("/notify-live/:id", eventsController.notifyLive)

eventRouter.get("/enrolled/:courseId", eventsController.getEnrolledStudents);

eventRouter.get("/:eventId", eventsController.getEventById)

eventRouter.post('/reminder', eventsController.eventReminder)

eventRouter.delete("/delete/:id", eventsController.deleteEvent)

module.exports = eventRouter;
