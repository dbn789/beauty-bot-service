// Ретеншн и удаление данных (ТЗ FR-I-080, FR-B-100, NFR-05):
// ежедневный sweep просроченных артефактов + немедленное удаление по требованию.
const { REQUEST_STATUS } = require('@beauty/shared');

const createRetention = ({ models, storage, config, logger }) => {
  const { GenerationRequest, User } = models;

  // Удаляем файлы и помечаем deletedAt у запросов старше retentionDays (S-ретеншн)
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
        paths: [
          request.sourcePhoto && request.sourcePhoto.storagePath,
          ...(request.variants || []).map((v) => v.storagePath),
        ].filter(Boolean),
      });
      await GenerationRequest.updateOne(
        { _id: request._id },
        { $set: { deletedAt: now } }
      );
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
        paths: [
          request.sourcePhoto && request.sourcePhoto.storagePath,
          ...(request.variants || []).map((v) => v.storagePath),
        ].filter(Boolean),
      });
      await GenerationRequest.updateOne(
        { _id: request._id },
        { $set: { deletedAt: new Date() } }
      );
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
          'dialogState.step': 'idle',
          'dialogState.photo': {
            storagePath: null, tgFileId: null, mime: null, bytes: 0, width: null, height: null,
          },
        },
      }
    );
    logger.info({ userId: String(user._id), requests: requests.length, files }, 'retention: user data deleted');
    return { requests: requests.length, files };
  };

  let timer = null;
  const start = () => {
    const period = 24 * 3600 * 1000;
    timer = setInterval(() => {
      deleteExpired().catch((error) => logger.error({ err: error.message }, 'retention sweep failed'));
    }, period);
    timer.unref();
    deleteExpired().catch((error) => logger.error({ err: error.message }, 'retention initial sweep failed'));
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { deleteExpired, deleteUserData, start, stop, statuses: REQUEST_STATUS };
};

module.exports = {
  createRetention,
};
