const mongoose = require('mongoose');

const RECOGNITION_BADGES = [
  'Team Player',
  'Innovation',
  'Leadership',
  'Extra Mile',
  'Customer Hero',
  'Above & Beyond',
];

const recognitionSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    badge: { type: String, enum: RECOGNITION_BADGES, default: 'Team Player' },
    message: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Recognition', recognitionSchema);
module.exports.RECOGNITION_BADGES = RECOGNITION_BADGES;
