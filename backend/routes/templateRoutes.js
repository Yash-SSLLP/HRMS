/**
 * Template router — mounted at /api/templates.
 * Editable email + letter wording. Every route needs the 'templates.manage'
 * capability, which a SuperAdmin grants from the Permissions page.
 */
const express = require('express');
const {
  listTemplates, getTemplate, saveTemplate, resetTemplate, previewTemplate, downloadTemplateTex,
} = require('../controllers/templateController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.use(requirePermission('templates.manage'));

// GET / — catalogue with current wording; protected, requires 'templates.manage'.
router.get('/', listTemplates);
// GET /:key/tex — download a letter template as an Overleaf-ready .tex file.
// Declared before '/:key' so the suffix isn't swallowed by the param route.
router.get('/:key/tex', downloadTemplateTex);
// GET /:key — one template; PUT — save an override; DELETE — reset to default.
router.route('/:key')
  .get(getTemplate)
  .put(saveTemplate)
  .delete(resetTemplate);
// POST /:key/preview — render a draft with sample values.
router.post('/:key/preview', previewTemplate);

module.exports = router;
