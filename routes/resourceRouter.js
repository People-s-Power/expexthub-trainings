const express = require('express');
const resourceController = require('../controllers/resourcesController.js');
const router = express.Router();

router.post("/add-new", resourceController.addCourseResources)
router.get("/all", resourceController.getResources)
router.get("/all/:id", resourceController.getAssignedResources)
router.get('/tutor/:tutorId', resourceController.getTutorResources);
router.put("/edit/:id", resourceController.editResource)
router.delete("/delete/:id", resourceController.deleteResource)

module.exports = router