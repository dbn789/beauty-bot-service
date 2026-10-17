const mongoose = require('mongoose');

// Разделы настроек, которыми управляет админка (Э4+: поэтапная реализация).
// Бот читает ту же коллекцию — env остаётся значением по умолчанию/аварийным.
const SETTINGS_SECTIONS = Object.freeze(['users', 'bot', 'generation', 'stand']);

const settingSchema = new mongoose.Schema({
  section: { type: String, enum: SETTINGS_SECTIONS, required: true, unique: true, index: true },
  // содержимое раздела наполняется по мере реализации пунктов настроек;
  // на каркасном этапе — заметка администратора
  data: { type: Object, default: {} },
  updatedBy: { type: String, default: null },
}, { timestamps: true, minimize: false });

const Setting = mongoose.model('Setting', settingSchema);

module.exports = {
  Setting,
  SETTINGS_SECTIONS,
};
