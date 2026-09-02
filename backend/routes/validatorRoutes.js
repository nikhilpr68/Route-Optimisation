const express = require('express');

const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const { runValidator } = require('../controllers/validatorController');

const router = express.Router();

router.post(
  '/run',
  protect,
  upload.fields([
    { name: 'testcase', maxCount: 1 },
    { name: 'result', maxCount: 1 },
  ]),
  runValidator
);

module.exports = router;
