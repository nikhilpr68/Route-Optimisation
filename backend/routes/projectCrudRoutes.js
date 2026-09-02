const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/authMiddleware');
const {
  createProject,
  listMyProjects,
  getProjectById,
  updateProject,
  deleteProject,
  bulkDeleteProjects,
  getProjectShare,
  createProjectShare,
  revokeProjectShare
} = require('../controllers/projectController');

router.post('/', protect, createProject);
router.get('/', protect, listMyProjects);
router.post('/bulk-delete', protect, bulkDeleteProjects);
router.get('/:id/share', protect, getProjectShare);
router.post('/:id/share', protect, createProjectShare);
router.delete('/:id/share', protect, revokeProjectShare);
router.get('/:id', protect, getProjectById);
router.put('/:id', protect, updateProject);
router.delete('/:id', protect, deleteProject);

module.exports = router;
