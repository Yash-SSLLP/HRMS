/**
 * Template controller — the editable email / letter wording.
 *
 * The catalogue is code (services/templateRegistry.js); this exposes it with
 * any org overrides applied, saves an override, resets one back to the shipped
 * default, and renders a preview with sample values so an editor can see the
 * result before anyone receives it.
 */
const asyncHandler = require('express-async-handler');
const Template = require('../models/Template');
const { getRegistry } = require('../services/templateRegistry');
const templates = require('../services/templates');
const { buildLetterTex } = require('../services/letterTex');
const COMPANY = require('../config/company');

/**
 * List every template with its current content.
 * @route GET /api/templates  (templates.manage)
 * @returns {{count: number, templates: Object[]}}
 */
const listTemplates = asyncHandler(async (req, res) => {
  const all = await templates.listAll();
  res.json({ count: all.length, templates: all });
});

/**
 * One template with its current content.
 * @route GET /api/templates/:key  (templates.manage)
 * @returns {{template: Object}}; 404 for an unknown key
 */
const getTemplate = asyncHandler(async (req, res) => {
  const all = await templates.listAll();
  const found = all.find((t) => t.key === req.params.key);
  if (!found) {
    res.status(404);
    throw new Error('Unknown template');
  }
  res.json({ template: found });
});

/**
 * Save an override for one template.
 * @route PUT /api/templates/:key  (templates.manage)
 * @param {string} [req.body.subject] - mail templates only
 * @param {string} req.body.body
 * @returns {{template: Object}}; 404 unknown key, 400 empty body
 */
const saveTemplate = asyncHandler(async (req, res) => {
  const base = getRegistry(req.params.key);
  if (!base) {
    res.status(404);
    throw new Error('Unknown template');
  }
  const body = String(req.body.body ?? '').trim();
  if (!body) {
    res.status(400);
    throw new Error('The template body cannot be empty. Use "Reset to default" to restore the original wording.');
  }
  const subject = base.format === 'mail' ? String(req.body.subject ?? '').trim() : '';
  if (base.format === 'mail' && !subject) {
    res.status(400);
    throw new Error('An email template needs a subject.');
  }

  await Template.findOneAndUpdate(
    { key: base.key },
    { key: base.key, subject, body, updatedBy: req.user._id },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // Drop the read cache so the very next send uses the new wording.
  templates.invalidate();

  const all = await templates.listAll();
  res.json({ template: all.find((t) => t.key === base.key) });
});

/**
 * Drop the override, restoring the shipped wording.
 * @route DELETE /api/templates/:key  (templates.manage)
 * @returns {{template: Object}}; 404 for an unknown key
 */
const resetTemplate = asyncHandler(async (req, res) => {
  const base = getRegistry(req.params.key);
  if (!base) {
    res.status(404);
    throw new Error('Unknown template');
  }
  await Template.deleteOne({ key: base.key });
  templates.invalidate();
  const all = await templates.listAll();
  res.json({ template: all.find((t) => t.key === base.key) });
});

/**
 * Render a template with sample values, without saving it — so the wording can
 * be checked before a candidate or employee receives it.
 * @route POST /api/templates/:key/preview  (templates.manage)
 * @param {string} [req.body.subject] - unsaved draft to preview
 * @param {string} [req.body.body] - unsaved draft to preview
 * @returns {{subject: string, body: string, blocks?: Object[], sample: Object}}
 */
const previewTemplate = asyncHandler(async (req, res) => {
  const base = getRegistry(req.params.key);
  if (!base) {
    res.status(404);
    throw new Error('Unknown template');
  }
  // Sample values so every placeholder resolves to something recognisable.
  const SAMPLES = {
    companyName: COMPANY.name,
    candidateName: 'Priya Sharma',
    employeeName: 'Priya Sharma',
    employeeCode: 'SSL 128',
    position: 'Senior Software Engineer',
    department: 'Engineering',
    departmentClause: ' in the Engineering department',
    salaryMonthly: '₹85,000',
    salaryAnnual: '₹10,20,000',
    probationMonths: '3',
    noticePeriodDays: '30',
    joiningDate: '1st September 2026',
    acceptanceDeadline: '20th August 2026',
    interviewRef: 'held on 5th August 2026',
    period: 'July 2026',
    link: 'https://hrms.example.com/secure-link',
    newEmail: 'priya.sharma@sequencesurface.com',
    oldEmail: 'priya@old.example.com',
    lastWorkingDay: '31st August 2026',
  };
  const sample = Object.fromEntries((base.variables || []).map((v) => [v, SAMPLES[v] ?? `«${v}»`]));

  // Preview the DRAFT the editor currently has, falling back to what is saved.
  const draftBody = String(req.body.body ?? '').trim();
  const draftSubject = String(req.body.subject ?? '').trim();
  const current = await templates.resolve(base.key);
  const body = draftBody || current.body;
  const subject = draftSubject || current.subject;

  res.json({
    subject: templates.fill(subject, sample),
    body: templates.fill(body, sample),
    blocks: base.format === 'letter' ? templates.parseLetterBody(templates.fill(body, sample)) : undefined,
    sample,
  });
});

/**
 * Download a letter template as a standalone Overleaf-ready .tex file, carrying
 * the wording it has right now (org override if one exists, else the shipped
 * default). Placeholders survive as \ph{name} rather than being filled, because
 * this exports the TEMPLATE, not one candidate's letter.
 *
 * Authoring aid only — the live PDF is still drawn by services/letterPdf.js, so
 * nothing here needs a TeX toolchain on the server.
 * @route GET /api/templates/:key/tex  (templates.manage)
 * @returns {text/x-tex} 400 for a mail template, 404 for an unknown key
 */
const downloadTemplateTex = asyncHandler(async (req, res) => {
  const reg = getRegistry(req.params.key);
  if (!reg) {
    res.status(404);
    throw new Error('Unknown template');
  }
  if (reg.format !== 'letter') {
    res.status(400);
    throw new Error('Only letter templates can be exported as LaTeX.');
  }

  // Current wording, override-aware — the same resolve() the renderer uses.
  const current = await templates.resolve(req.params.key);
  const blocks = templates.parseLetterBody(current.body);

  const tex = buildLetterTex({
    key: reg.key,
    label: reg.name,
    blocks,
    variables: reg.variables || [],
    // Only the appointment letter carries the CTC annexure on page 2.
    annexure: reg.key === 'appointment.letter',
  });

  const filename = `${reg.key.replace(/\./g, '-')}.tex`;
  res.setHeader('Content-Type', 'application/x-tex; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(tex);
});

module.exports = {
  listTemplates, getTemplate, saveTemplate, resetTemplate, previewTemplate, downloadTemplateTex,
};
