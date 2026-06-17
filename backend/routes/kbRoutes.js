const express = require('express');
const {
  listArticles, getArticle, createArticle, updateArticle, deleteArticle,
} = require('../controllers/kbController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Any authenticated user may read
router.get('/', listArticles);
router.get('/:id', getArticle);

// Admin-only writes
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.post('/', createArticle);
router.route('/:id').put(updateArticle).delete(deleteArticle);

module.exports = router;
