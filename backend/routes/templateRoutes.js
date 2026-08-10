/**
 * Template router — mounted at /api/templates.
 * Editable email + letter wording. Every route needs the 'templates.manage'
 * capability, which a SuperAdmin grants from the Permissions page.
 */
const express = require('express');
const {
  listTemplates, getTemplate, saveTemplate, resetTemplate, previewTemplate,
} = require('../controllers/templateController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.use(requirePermission('templates.manage'));

// GET / — catalogue with current wording; protected, requires 'templates.manage'.
router.get('/', listTemplates);
// GET /:key — one template; PUT — save an override; DELETE — reset to default.
router.route('/:key')
  .get(getTemplate)
  .put(saveTemplate)
  .delete(resetTemplate);
// POST /:key/preview — render a draft with sample values.
router.post('/:key/preview', previewTemplate);

module.exports = router;
