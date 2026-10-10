const mongoose = require('mongoose');

const { REQUEST_STATUS, REQUEST_SOURCE, PRESET_CATEGORIES } = require('../constants');

const variantSchema = new mongoose.Schema({
  storagePath: { type: String, required: true },
  providerTaskId: { type: String, default: null },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
  costUsd: { type: Number, default: 0 },
}, { _id: false });

const generationRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: {
    type: String,
    enum: Object.values(REQUEST_STATUS),
    default: REQUEST_STATUS.QUEUED,
    index: true,
  },
  source: {
    type: String,
    enum: Object.values(REQUEST_SOURCE),
    required: true,
  },
  presetCode: { type: String, default: null },
  userText: { type: String, default: null },
  finalPrompt: { type: String, required: true },
  sourcePhoto: {
    storagePath: { type: String, required: true },
    tgFileId: { type: String, required: true },
    mime: { type: String, default: 'image/jpeg' },
    bytes: { type: Number, default: 0 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
  },
  variants: { type: [variantSchema], default: [] },
  provider: { type: String, default: null },
  model: { type: String, default: null },
  durationMs: { type: Number, default: null },
  error: {
    type: {
      code: String,
      message: String,
      retried: { type: Boolean, default: false },
    },
    default: null,
  },
  // YYYY-MM-DD (Europe/Moscow) для суточных лимитов и бюджета
  day: { type: String, required: true, index: true },
  completedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

generationRequestSchema.index({ createdAt: -1 });

const GenerationRequest = mongoose.model('GenerationRequest', generationRequestSchema);

module.exports = {
  GenerationRequest,
  PRESET_CATEGORIES,
};
