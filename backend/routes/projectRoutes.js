const express = require('express');
const router = express.Router();

const projectCrudRoutes = require('./projectCrudRoutes');
const projectPipelineRoutes = require('./projectPipelineRoutes');

router.use('/', projectCrudRoutes);
router.use('/', projectPipelineRoutes);

module.exports = router;
