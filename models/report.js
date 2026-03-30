const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  victimId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reportedId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  report: String,
  images: [String],
  importance: { type: Number, default: 1 }
}, { timestamps: true });


const Report = mongoose.model('Report', reportSchema);

module.exports = Report;