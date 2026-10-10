const mongoose = require('mongoose');

const { PRESET_CATEGORIES } = require('../constants');

const presetSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  titleRu: { type: String, required: true },
  category: { type: String, enum: PRESET_CATEGORIES, required: true },
  promptEn: { type: String, required: true },
  emoji: { type: String, default: '💇' },
  sortOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const Preset = mongoose.model('Preset', presetSchema);

module.exports = {
  Preset,
};
