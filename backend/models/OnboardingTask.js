const mongoose = require('mongoose');

const ONBOARDING_CATEGORIES = ['Documentation', 'IT Setup', 'HR', 'Finance', 'Training', 'Introduction', 'Other'];
const ONBOARDING_STATUS = ['Pending', 'InProgress', 'Done'];

const onboardingTaskSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: ONBOARDING_CATEGORIES, default: 'Other' },
    status: { type: String, enum: ONBOARDING_STATUS, default: 'Pending', index: true },
    dueDate: Date,
    completedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

onboardingTaskSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.title });

module.exports = mongoose.model('OnboardingTask', onboardingTaskSchema);
module.exports.ONBOARDING_CATEGORIES = ONBOARDING_CATEGORIES;
module.exports.ONBOARDING_STATUS = ONBOARDING_STATUS;
