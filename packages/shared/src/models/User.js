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
    // Загруженное фото клиента между шагами «фото → выбор стиля».
    // В ТЗ 8.1 заявлен photoId (ObjectId); реализация хранит снимок метаданных
    // файла напрямую — отдельная коллекция photos для v1 не нужна.
    photo: {
      storagePath: { type: String, default: null },
      tgFileId: { type: String, default: null },
      mime: { type: String, default: null },
      bytes: { type: Number, default: 0 },
      width: { type: Number, default: null },
      height: { type: Number, default: null },
    },
  },
  generationsTotal: { type: Number, default: 0 },
  dataDeletedAt: { type: Date, default: null },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

module.exports = {
  User,
};
