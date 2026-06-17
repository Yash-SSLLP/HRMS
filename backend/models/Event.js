const mongoose = require('mongoose');

// A general calendar event (town hall, meeting, celebration, etc.) created by
// HR/SuperAdmin. Distinct from Holiday — events fan out a notification to everyone.
const eventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    date: { type: Date, required: true, index: true },
    time: { type: String, trim: true }, // optional free-text, e.g. "4:00 PM"
    location: { type: String, trim: true },
    description: { type: String, trim: true, maxlength: 5000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Event', eventSchema);
