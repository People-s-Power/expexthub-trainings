const express = require('express');
const workspaceController = require('../controllers/workspaceController');


const WorkspaceRoute = express.Router();



WorkspaceRoute.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to ExpertHub Workspace route" })
});





//workspace
WorkspaceRoute.get("/category", workspaceController.getWorkspaceByCategory);
WorkspaceRoute.get("/category/creator", workspaceController.getSpaceProviderSpaces);
WorkspaceRoute.get("/creator/:userId", workspaceController.getPlatformWorkspaces);

WorkspaceRoute.get("/all", workspaceController.getAllWorkspaces);




WorkspaceRoute.post("/add-workspace/:userId", workspaceController.addWorkSpace);
WorkspaceRoute.get("/single-workspace/:workspaceId", workspaceController.getWorkSpaceById);

//workspace enroll route
WorkspaceRoute.get("/admissions/:workspaceId", workspaceController.getEnrolledClients);
WorkspaceRoute.post("/enroll/:workspaceId", workspaceController.enrollWorkspace);
WorkspaceRoute.post("/assign/:workspaceId", workspaceController.assignedSpaceProvider);

WorkspaceRoute.get("/enrolled-workspaces/:userId", workspaceController.getEnrolledWorkspaces);
//get roundom courses
WorkspaceRoute.get("/recommended-workspaces/:userId", workspaceController.getRecommendedWorkspace);

// get all courses with category

WorkspaceRoute.get("/all/category", workspaceController.getAllCategory);
WorkspaceRoute.delete("/delete/:id", workspaceController.deleteWorkspace);
WorkspaceRoute.put("/edit/:id", workspaceController.editWorkSpace);


WorkspaceRoute.get("/unapproved", workspaceController.getUnaproved);
WorkspaceRoute.put("/approve/:workspaceId", workspaceController.approveWorkspace);

// uplaod video
WorkspaceRoute.put('/update-status/:workspaceId', workspaceController.updateStatus);
WorkspaceRoute.get('/renew/:workspaceId/:id', workspaceController.renewWorkspace);

module.exports = WorkspaceRoute;
