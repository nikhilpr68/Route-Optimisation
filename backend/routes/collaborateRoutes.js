const express = require('express');

const {
  addTeamMember,
  createAssignment,
  createTeam,
  deleteAssignment,
  getTeamById,
  joinTeamByCode,
  listTeams,
  postMessage,
  removeTeamMember,
  searchUsers,
  shareProject,
  updateTeamMember,
} = require('../controllers/collaborateController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/', listTeams);
router.post('/', createTeam);
router.post('/join', joinTeamByCode);
router.get('/users/search', searchUsers);
router.get('/:teamId', getTeamById);
router.post('/:teamId/members', addTeamMember);
router.patch('/:teamId/members/:userId', updateTeamMember);
router.delete('/:teamId/members/:userId', removeTeamMember);
router.post('/:teamId/projects', shareProject);
router.post('/:teamId/assignments', createAssignment);
router.delete('/:teamId/assignments/:assignmentId', deleteAssignment);
router.post('/:teamId/messages', postMessage);

module.exports = router;
