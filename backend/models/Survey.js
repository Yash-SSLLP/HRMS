const mongoose = require('mongoose');

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

surveyResponseSchema.index({ survey: 1, respondent: 1 }, { unique: true });

const Survey = mongoose.model('Survey', surveySchema);
const SurveyResponse = mongoose.model('SurveyResponse', surveyResponseSchema);

module.exports = Survey;
module.exports.SurveyResponse = SurveyResponse;
module.exports.QUESTION_TYPES = QUESTION_TYPES;
