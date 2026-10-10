// Ретеншн и удаление данных (ТЗ FR-I-080, FR-B-100, NFR-05):
// ежедневный sweep просроченных артефактов + немедленное удаление по требованию.
// При удалении из документов зачищаются ПДн (tgFileId, текст пожелания, промпт) —
// чтобы «данные удалены» было правдой, а не только файлы (ревью 3e35882, риск 6).
const { REQUEST_STATUS, DIALOG_STEP } = require('@beauty/shared');

const EMPTY_PHOTO = {
  storagePath: null, tgFileId: null, mime: null, bytes: 0, width: null, height: null, uploadedAt: null,
};

const createRetention = ({ models, storage, config, logger }) => {
  const { GenerationRequest, User } = models;

  // ——— внутреннее ———

  const stripPersonalData = {
    'sourcePhoto.tgFileId': null,
    userText: null,
    finalPrompt: '—',
  };

  const markDeleted = (requestId, now) =>
    GenerationRequest.updateOne(
      { _id: requestId },
      { $set: { deletedAt: now, ...stripPersonalData } }
    );

  const requestPaths = (request) => [
    request.sourcePhoto && request.sourcePhoto.storagePath,
    ...(request.variants || []).map((v) => v.storagePath),
  ].filter(Boolean);

  // ——— публичные операции ———

  // Удаляем файлы и помечаем deletedAt у запросов старше retentionDays (FR-I-080)
  const deleteExpired = async (now = new Date()) => {
    const boundary = new Date(now.getTime() - config.retentionDays * 24 * 3600 * 1000);
    const stale = await GenerationRequest.find(
      { createdAt: { $lt: boundary }, deletedAt: null },
      { variants: 1, sourcePhoto: 1 }
    ).lean();
    let touched = 0;
    for (const request of stale) {
      await storage.deleteRequestArtifacts({
        requestId: request._id,
        paths: requestPaths(request),
      });
      await markDeleted(request._id, now);
      touched += 1;
    }
    if (touched > 0) logger.info({ touched }, 'retention: expired requests cleaned');
    return touched;
  };

  // S6: немедленное удаление всех данных пользователя
  const deleteUserData = async (user) => {
    const requests = await GenerationRequest.find(
      { userId: user._id, deletedAt: null },
      { variants: 1, sourcePhoto: 1 }
    ).lean();
    let files = 0;
    for (const request of requests) {
      files += await storage.deleteRequestArtifacts({
        requestId: request._id,
        paths: requestPaths(request),
      });
      await markDeleted(request._id, new Date());
    }
    // несвязанный исходник из dialogState
    if (user.dialogState.photo && user.dialogState.photo.storagePath) {
      files += await storage.deleteFiles([user.dialogState.photo.storagePath]);
    }
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          dataDeletedAt: new Date(),
          'dialogState.step': DIALOG_STEP.IDLE,
          'dialogState.photo': EMPTY_PHOTO,
        },
      }
    );
    logger.info({ userId: String(user._id), requests: requests.length, files }, 'retention: user data deleted');
    return { requests: requests.length, files };
  };

  // FR-I-080 для «болтающихся» фото: загружены, но генерации не было.
  // У запросов свои копии исходников, так что чистка диалогового файла им не мешает.
  const deleteStaleDialogPhotos = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
    const users = await User.find({
      'dialogState.photo.storagePath': { $ne: null },
      'dialogState.photo.uploadedAt': { $lt: cutoff },
    }).lean();
    let cleaned = 0;
    for (const user of users) {
      await storage.deleteFiles([user.dialogState.photo.storagePath]);
      const step = user.dialogState.step === DIALOG_STEP.AWAIT_CHOICE
        ? DIALOG_STEP.IDLE
        : user.dialogState.step;
      await User.updateOne(
        { _id: user._id },
        { $set: { 'dialogState.step': step, 'dialogState.photo': EMPTY_PHOTO } }
      );
      cleaned += 1;
    }
    if (cleaned > 0) logger.info({ cleaned }, 'retention: stale dialog photos cleaned');
    return cleaned;
  };

  let timer = null;
  const start = () => {
    const period = 24 * 3600 * 1000;
    const sweep = () => {
      deleteExpired().catch((error) => logger.error({ err: error.message }, 'retention sweep failed'));
      deleteStaleDialogPhotos().catch((error) => logger.error({ err: error.message }, 'stale photos sweep failed'));
    };
    timer = setInterval(sweep, period);
    timer.unref();
    sweep();
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { deleteExpired, deleteUserData, deleteStaleDialogPhotos, start, stop, statuses: REQUEST_STATUS };
};

module.exports = {
  createRetention,
};
