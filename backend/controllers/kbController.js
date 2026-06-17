const asyncHandler = require('express-async-handler');
const KbArticle = require('../models/KbArticle');

const USER_FIELDS = 'firstName lastName email role';

// Normalize tags: accept an array or a comma-separated string -> array of
// trimmed, non-empty strings.
const normalizeTags = (tags) => {
  let arr = tags;
  if (typeof tags === 'string') arr = tags.split(',');
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => String(t).trim()).filter((t) => t.length > 0);
};

// GET /  — employees see only published; admins see all. Optional ?category and ?q.
const listArticles = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === 'Employee') filter.published = true;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.q) {
    const rx = new RegExp(req.query.q, 'i');
    filter.$or = [{ title: rx }, { body: rx }];
  }
  const articles = await KbArticle.find(filter)
    .populate('createdBy', USER_FIELDS)
    .sort({ updatedAt: -1 });
  res.json({ count: articles.length, articles });
});

// GET /:id
const getArticle = asyncHandler(async (req, res) => {
  const article = await KbArticle.findById(req.params.id).populate('createdBy', USER_FIELDS);
  if (!article || (!article.published && req.user.role === 'Employee')) {
    res.status(404);
    throw new Error('Article not found');
  }
  res.json({ article });
});

// POST /  (admin)
const createArticle = asyncHandler(async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) {
    res.status(400);
    throw new Error('title and body are required');
  }
  const article = await KbArticle.create({
    ...req.body,
    tags: normalizeTags(req.body.tags),
    createdBy: req.user._id,
  });
  res.status(201).json({ article });
});

// PUT /:id  (admin)
const updateArticle = asyncHandler(async (req, res) => {
  const article = await KbArticle.findById(req.params.id);
  if (!article) {
    res.status(404);
    throw new Error('Article not found');
  }
  delete req.body.createdBy;
  if (req.body.tags !== undefined) req.body.tags = normalizeTags(req.body.tags);
  Object.assign(article, req.body);
  await article.save();
  res.json({ article });
});

// DELETE /:id  (admin)
const deleteArticle = asyncHandler(async (req, res) => {
  const article = await KbArticle.findById(req.params.id);
  if (!article) {
    res.status(404);
    throw new Error('Article not found');
  }
  await article.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listArticles, getArticle, createArticle, updateArticle, deleteArticle,
};
