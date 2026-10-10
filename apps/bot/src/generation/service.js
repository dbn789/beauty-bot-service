// Оркестратор генерации (ТЗ FR-G-020..110): лимиты, бюджет-стоп, очередь, ретраи,
// сохранение результатов и метрик. Возвращает promise-обёртку, которая не reject'ит —
// исход всегда фиксируется в GenerationRequest (статусы/ошибки), а бот-слой решает, что писать клиенту.
const {
  User,
  GenerationRequest,
  REQUEST_STATUS,
  ERROR_CODE,
  estimateCostUsd,
  buildHairstylePrompt,
} = require('@beauty/shared');

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`generation timed out after ${ms}ms`);
      error.code = ERROR_CODE.PROVIDER_TIMEOUT;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const isRetryableError = (error) =>
  [ERROR_CODE.PROVIDER_TIMEOUT, ERROR_CODE.PROVIDER_ERROR, 'network'].includes(error && error.code);

const createGenerationService = ({ models = { User, GenerationRequest }, storage, provider, config, logger, queue, dayKey = require('../helpers/day').moscowDayKey }) => {
  const spentTodayUsd = async (day) => {
    const rows = await models.GenerationRequest.aggregate([
      { $match: { day, status: REQUEST_STATUS.DONE } },
      { $unwind: '$variants' },
      { $group: { _id: null, spent: { $sum: '$variants.costUsd' } } },
    ]);
    return rows.length ? rows[0].spent : 0;
  };

  const countDoneToday = (userId, day) =>
    models.GenerationRequest.countDocuments({
      userId, day, status: REQUEST_STATUS.DONE,
    });

  /**
   * Принимает проверенные данные к генерации. Никогда не бросает — возвращает исход.
   * @returns {Promise<{limited?:boolean, budgetStopped?:boolean, requestId?:string, promise?:Promise}>}
   */
  const submitRequest = async ({ user, photo, source, preset = null, userText = null, day = dayKey() }) => {
    // FR-B-080: суточный лимит (считаем успешные генерации)
    const doneToday = await countDoneToday(user._id, day);
    if (doneToday >= config.dailyLimit) {
      return { limited: true };
    }

    // FR-G-080: дневной бюджет-стоп (оценка до вызова провайдера)
    const estimate = estimateCostUsd(provider.name, provider.model, config.variants) || 0;
    const spent = await spentTodayUsd(day);
    if (estimate > 0 && spent + estimate > config.dailyBudgetUsd) {
      const request = await models.GenerationRequest.create({
        userId: user._id,
        status: REQUEST_STATUS.BUDGET_STOPPED,
        source,
        presetCode: preset ? preset.code : null,
        userText,
        finalPrompt: '—',
        sourcePhoto: photo,
        provider: provider.name,
        model: provider.model,
        day,
      });
      logger.warn({ day, spent, estimate, requestId: String(request._id) }, 'budget stop');
      return { budgetStopped: true, requestId: String(request._id) };
    }

    const finalPrompt = buildHairstylePrompt({
      request: preset ? preset.promptEn : userText,
    });

    const request = await models.GenerationRequest.create({
      userId: user._id,
      status: REQUEST_STATUS.QUEUED,
      source,
      presetCode: preset ? preset.code : null,
      userText,
      finalPrompt,
      sourcePhoto: photo,
      provider: provider.name,
      model: provider.model,
      day,
    });

    const promise = queue.add(() => processRequest(String(request._id)));
    return { requestId: String(request._id), promise };
  };

  const runProvider = async (request) => withTimeout(
    provider.generate({
      imageRef: request.sourcePhoto.storagePath,
      prompt: request.finalPrompt,
      variants: config.variants,
    }),
    config.generationTimeoutMs
  );

  const processRequest = async (requestId) => {
    const request = await models.GenerationRequest.findById(requestId);
    if (!request || request.status !== REQUEST_STATUS.QUEUED) {
      return { ok: false, request, reason: 'not_queued' };
    }
    request.status = REQUEST_STATUS.PROCESSING;
    await request.save();

    const startedAt = Date.now();
    let result = null;
    let lastError = null;
    let retried = false;

    try {
      result = await runProvider(request);
    } catch (firstError) {
      lastError = firstError;
      if (isRetryableError(firstError)) {
        retried = true; // FR-G-060: один автоповтор
        try {
          result = await runProvider(request);
        } catch (secondError) {
          lastError = secondError;
        }
      }
    }

    if (result) {
      const perVariantCost = estimateCostUsd(provider.name, provider.model, 1) || 0;
      const variants = [];
      for (let i = 0; i < result.images.length; i += 1) {
        const image = result.images[i];
        const storagePath = await storage.saveVariant({
          requestId: String(request._id),
          index: i,
          buffer: image.buffer,
        });
        variants.push({
          storagePath,
          providerTaskId: image.providerTaskId || null,
          width: image.width || null,
          height: image.height || null,
          costUsd: perVariantCost,
        });
      }
      request.variants = variants;
      request.status = REQUEST_STATUS.DONE;
      request.durationMs = Date.now() - startedAt;
      request.completedAt = new Date();
      await request.save();
      await models.User.updateOne({ _id: request.userId }, { $inc: { generationsTotal: 1 } });
      logger.info({ requestId, durationMs: request.durationMs, variants: variants.length }, 'generation done');
      return { ok: true, request };
    }

    request.status = REQUEST_STATUS.ERROR;
    request.error = {
      code: (lastError && lastError.code) || ERROR_CODE.INTERNAL,
      message: (lastError && lastError.message) || 'unknown error',
      retried,
    };
    request.durationMs = Date.now() - startedAt;
    await request.save();
    logger.error({ requestId, err: request.error }, 'generation failed');
    return { ok: false, request };
  };

  // S7: рестарт во время генерации — висящие запросы в error
  const recoverInterrupted = async (now = new Date()) => {
    const boundary = new Date(now.getTime() - 5 * 60 * 1000);
    const result = await models.GenerationRequest.updateMany(
      {
        status: { $in: [REQUEST_STATUS.QUEUED, REQUEST_STATUS.PROCESSING] },
        updatedAt: { $lt: boundary },
      },
      {
        $set: {
          status: REQUEST_STATUS.ERROR,
          error: { code: ERROR_CODE.INTERNAL, message: 'interrupted by restart', retried: false },
        },
      }
    );
    if (result.modifiedCount > 0) {
      logger.warn({ count: result.modifiedCount }, 'recovered interrupted requests');
    }
    return result.modifiedCount;
  };

  const lastDoneRequest = (userId) =>
    models.GenerationRequest.findOne({ userId, status: REQUEST_STATUS.DONE }).sort({ createdAt: -1 });

  return {
    submitRequest,
    processRequest,
    recoverInterrupted,
    lastDoneRequest,
    spentTodayUsd,
  };
};

module.exports = {
  createGenerationService,
  isRetryableError,
};
