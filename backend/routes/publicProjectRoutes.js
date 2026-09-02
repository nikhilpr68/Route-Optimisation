const express = require('express');

const { getSharedProjectByToken } = require('../controllers/projectController');

const router = express.Router();

router.get('/projects/:token', getSharedProjectByToken);

module.exports = router;
