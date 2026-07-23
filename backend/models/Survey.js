const mongoose = require('mongoose');

// Employee-engagement surveys. Defines two models: Survey (a questionnaire with
// embedded questions and an optional open window) and SurveyResponse (one
// employee's answers, one per respondent). Default export is Survey.
// single = pick one option; multi = pick several; text = free-text answer.
const QUESTION_TYPES = ['single', 'multi', 'text'];

const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    type: { type: String, enum: QUESTION_TYPES, default: 'single' },
    options: [{ type: String }],
  },
  { _id: false }
);

const surveySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    questions: [questionSchema],
    anonymous: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    // Optional display window. Blank startDate = open immediately; blank endDate
    // = never expires. A survey shows to employees only if `active` AND today is
    // inside this window (both must pass).
    startDate: { type: Date },
    endDate: { type: Date, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const answerSchema = new mongoose.Schema(
  {
    questionIndex: { type: Number },
    choice: [{ type: String }],
    text: { type: String },
  },
  { _id: false }
);

const surveyResponseSchema = new mongoose.Schema(
  {
    survey: { type: mongoose.Schema.Types.ObjectId, ref: 'Survey', required: true, index: true },
    respondent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    answers: [answerSchema],
  },
  { timestamps: true }
);

// One response per respondent per survey (no double submissions).
surveyResponseSchema.index({ survey: 1, respondent: 1 }, { unique: true });

const Survey = mongoose.model('Survey', surveySchema);
const SurveyResponse = mongoose.model('SurveyResponse', surveyResponseSchema);

module.exports = Survey;
module.exports.SurveyResponse = SurveyResponse;
module.exports.QUESTION_TYPES = QUESTION_TYPES;
