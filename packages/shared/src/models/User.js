const mongoose = require('mongoose');

const { DIALOG_STEP } = require('../constants');

const userSchema = new mongoose.Schema({
  tgId: { type: Number, required: true, unique: true, index: true },
  username: { type: String, default: null },
  firstName: { type: String, default: null },
  lastName: { type: String, default: null },
  // Согласие на обработку фото (ТЗ FR-B-020): null — бот не пускает к генерации
  privacyAcceptedAt: { type: Date, default: null },
  dialogState: {
    step: {
      type: String,
      enum: Object.values(DIALOG_STEP),
      default: DIALOG_STEP.IDLE,
    },
    photoId: { type: mongoose.Schema.Types.ObjectId, default: null },
    presetCode: { type: String, default: null },
  },
  generationsTotal: { type: Number, default: 0 },
  dataDeletedAt: { type: Date, default: null },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

module.exports = {
  User,
};
