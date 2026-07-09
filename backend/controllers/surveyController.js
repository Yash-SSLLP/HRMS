const asyncHandler = require('express-async-handler');
const Survey = require('../models/Survey');
const { SurveyResponse } = require('../models/Survey');

// A Mongo predicate matching docs whose optional [startDate, endDate] window
// contains `now`. Absent/null bounds are treated as open-ended.
const activeWindowQuery = (now) => ({
  $and: [
    { $or: [{ startDate: { $exists: false } }, { startDate: null }, { startDate: { $lte: now } }] },
    { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: now } }] },
  ],
});

// ===== Shared / Employee =====

// GET /  — surveys open to the current user: active AND inside their display
// window, with an `answered` flag.
const listActive = asyncHandler(async (req, res) => {
  const surveys = await Survey.find({ active: true, ...activeWindowQuery(new Date()) })
    .sort({ createdAt: -1 })
    .lean();
  const responded = await SurveyResponse.find({
    survey: { $in: surveys.map((s) => s._id) },
    respondent: req.user._id,
  }).select('survey').lean();
  const answeredSet = new Set(responded.map((r) => String(r.survey)));
  const withFlag = surveys.map((s) => ({ ...s, answered: answeredSet.has(String(s._id)) }));
  res.json({ count: withFlag.length, surveys: withFlag });
});

// GET /:id  — a single survey with `answered` flag
const getSurvey = asyncHandler(async (req, res) => {
  const survey = await Survey.findById(req.params.id).lean();
  if (!survey) {
    res.status(404);
    throw new Error('Survey not found');
  }
  const existing = await SurveyResponse.findOne({ survey: survey._id, respondent: req.user._id }).lean();
  res.json({ ...survey, answered: !!existing });
});

// POST /:id/respond  — submit answers
const respond = asyncHandler(async (req, res) => {
  const survey = await Survey.findById(req.params.id);
  if (!survey) {
    res.status(404);
    throw new Error('Survey not found');
  }
  // Reject late submissions from a stale open tab once the survey is closed or
  // its display window has passed.
  const now = new Date();
  const closed =
    survey.active === false ||
    (survey.startDate && survey.startDate > now) ||
    (survey.endDate && survey.endDate < now);
  if (closed) {
    res.status(400);
    throw new Error('This survey has closed');
  }
  const already = await SurveyResponse.findOne({ survey: survey._id, respondent: req.user._id });
  if (already) {
    res.status(400);
    throw new Error('You have already responded to this survey');
  }
  const { answers } = req.body;
  await SurveyResponse.create({
    survey: survey._id,
    respondent: req.user._id,
    answers: Array.isArray(answers) ? answers : [],
  });
  res.status(201).json({ ok: true });
});

// ===== HR/Admin =====

// GET /admin/all  — every survey incl. inactive, with responseCount
const listAllAdmin = asyncHandler(async (req, res) => {
  const surveys = await Survey.find({}).sort({ createdAt: -1 }).lean();
  const counts = await SurveyResponse.aggregate([
    { $group: { _id: '$survey', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  const withCount = surveys.map((s) => ({ ...s, responseCount: countMap.get(String(s._id)) || 0 }));
  res.json({ count: withCount.length, surveys: withCount });
});

// POST /  — create a survey
const createSurvey = asyncHandler(async (req, res) => {
  const { title, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    res.status(400);
    throw new Error('title and at least one question are required');
  }
  const survey = await Survey.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ survey });
});

// PUT /:id  — update a survey
const updateSurvey = asyncHandler(async (req, res) => {
  const survey = await Survey.findById(req.params.id);
  if (!survey) {
    res.status(404);
    throw new Error('Survey not found');
  }
  delete req.body.createdBy;
  Object.assign(survey, req.body);
  await survey.save();
  res.json({ survey });
});

// DELETE /:id  — delete a survey and its responses
const deleteSurvey = asyncHandler(async (req, res) => {
  const survey = await Survey.findById(req.params.id);
  if (!survey) {
    res.status(404);
    throw new Error('Survey not found');
  }
  await SurveyResponse.deleteMany({ survey: survey._id });
  await survey.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// GET /:id/results  — aggregated results, respecting anonymity
const results = asyncHandler(async (req, res) => {
  const survey = await Survey.findById(req.params.id).lean();
  if (!survey) {
    res.status(404);
    throw new Error('Survey not found');
  }
  const responses = await SurveyResponse.find({ survey: survey._id }).select('answers').lean();

  const out = (survey.questions || []).map((q, qi) => {
    if (q.type === 'text') {
      const texts = [];
      responses.forEach((r) => {
        const ans = (r.answers || []).find((a) => a.questionIndex === qi);
        if (ans && ans.text && String(ans.text).trim()) texts.push(ans.text);
      });
      return { questionIndex: qi, text: q.text, type: q.type, texts };
    }
    // single / multi -> counts per option
    const counts = {};
    (q.options || []).forEach((opt) => { counts[opt] = 0; });
    responses.forEach((r) => {
      const ans = (r.answers || []).find((a) => a.questionIndex === qi);
      if (!ans) return;
      (ans.choice || []).forEach((c) => {
        counts[c] = (counts[c] || 0) + 1;
      });
    });
    return { questionIndex: qi, text: q.text, type: q.type, counts };
  });

  res.json({ survey, totalResponses: responses.length, results: out });
});

module.exports = {
  listActive,
  getSurvey,
  respond,
  listAllAdmin,
  createSurvey,
  updateSurvey,
  deleteSurvey,
  results,
};
