// Оркестратор генерации (ТЗ FR-G-020..110): лимиты, бюджет-стоп, очередь, ретраи,
// сохранение результатов и метрик. submitRequest никогда не бросает — исход
// фиксируется в GenerationRequest, а бот-слой решает, что писать клиенту.
const path = require('path');
const {
  User,
  GenerationRequest,
  REQUEST_STATUS,
  DIALOG_STEP,
  ERROR_CODE,
  estimateCostUsd,
  buildHairstylePrompt,
} = require('@beauty/shared');

// Таймаут с реальной отменой: AbortSignal уходит провайдеру (fetch прерывается),
// гонка страхует от провайдеров, которые сигнал игнорируют. abort() в finally
// гасит и «осиротевшие» polling-циклы после успеха (ревью 2c82805, риск 6).
const runWithTimeout = async (fn, ms) => {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`generation timed out after ${ms}ms`);
      error.code = ERROR_CODE.PROVIDER_TIMEOUT;
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

const isRetryableError = (error) =>
  [ERROR_CODE.PROVIDER_TIMEOUT, ERROR_CODE.PROVIDER_ERROR, 'provider_rate', 'network']
    .includes(error && error.code);

const createGenerationService = ({
  models = { User, GenerationRequest },
  storage,
  provider,
  config,
  logger,
  queue,
  dayKey = require('../helpers/day').moscowDayKey,
}) => {
  const spentTodayUsd = async (day) => {
    const rows = await models.GenerationRequest.aggregate([
      { $match: { day, status: REQUEST_STATUS.DONE } },
      { $unwind: '$variants' },
      { $group: { _id: null, spent: { $sum: '$variants.costUsd' } } },
    ]);
    return rows.length ? rows[0].spent : 0;
  };

  // FR-B-080 c учётом обхода через /cancel (ревью 308372d, риск 1):
  // списываются успешные И находящиеся в работе запросы; error не списывается
  const countAccountedToday = (userId, day) =>
    models.GenerationRequest.countDocuments({
      userId,
      day,
      status: { $in: [REQUEST_STATUS.DONE, REQUEST_STATUS.QUEUED, REQUEST_STATUS.PROCESSING] },
    });

  // Оценочная стоимость очереди (queued/processing) — чтобы параллельные отправки
  // не обошли дневной бюджет (ревью 3e35882, риск 2)
  const countInFlightToday = (day) =>
    models.GenerationRequest.countDocuments({
      day, status: { $in: [REQUEST_STATUS.QUEUED, REQUEST_STATUS.PROCESSING] },
    });

  /**
   * Принимает проверенные данные к генерации. Никогда не бросает — возвращает исход.
   * @returns {Promise<{limited|busy|budgetStopped|invalidPhoto|requestId|promise}>}
   */
  const submitRequest = async ({ user, photo, source, preset = null, userText = null, day = dayKey() }) => {
    // FR-B-080: суточный лимит (успешные + в работе, чтобы /cancel не открывал обход)
    const accountedToday = await countAccountedToday(user._id, day);
    if (accountedToday >= config.dailyLimit) {
      return { limited: true };
    }

    // Защита очереди от переполнения
    if (queue.size >= config.maxQueueSize) {
      logger.warn({ size: queue.size }, 'generation queue full');
      return { busy: true };
    }

    // FR-G-080: дневной бюджет-стоп (оценка до вызова провайдера, включая очередь)
    const estimate = estimateCostUsd(provider.name, provider.model, config.variants) || 0;
    if (estimate > 0) {
      const [spent, inFlight] = await Promise.all([spentTodayUsd(day), countInFlightToday(day)]);
      if (spent + (inFlight + 1) * estimate > config.dailyBudgetUsd) {
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
        logger.warn({ day, spent, inFlight, estimate, requestId: String(request._id) }, 'budget stop');
        return { budgetStopped: true, requestId: String(request._id) };
      }
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

    // Собственная копия исходника для запроса (ревью 3e35882, риск 5):
    // новая загрузка пользователя не ломает more:last / act:retry
    try {
      const ext = path.extname(photo.storagePath).slice(1) || 'jpg';
      const ownPath = await storage.copyFile({
        from: photo.storagePath,
        to: path.join('results', String(request._id), `source.${ext}`),
      });
      request.sourcePhoto.storagePath = ownPath;
      await request.save();
    } catch (error) {
      logger.error({ requestId: String(request._id), err: error.message }, 'source photo copy failed');
      request.status = REQUEST_STATUS.ERROR;
      request.error = { code: ERROR_CODE.VALIDATION, message: 'source photo is missing', retried: false };
      await request.save();
      return { invalidPhoto: true, requestId: String(request._id) };
    }

    const promise = queue.add(() => processRequest(String(request._id)));
    return { requestId: String(request._id), promise };
  };

  const runProvider = (request) =>
    runWithTimeout(
      async (signal) => {
        // провайдеру нужен сам файл (data URI), а не только путь
        const imageBuffer = await storage.read(request.sourcePhoto.storagePath);
        return provider.generate({
          imageRef: request.sourcePhoto.storagePath,
          imageBuffer,
          mime: request.sourcePhoto.mime || 'image/jpeg',
          prompt: request.finalPrompt,
          variants: config.variants,
          signal,
        });
      },
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

      // клиент удалил данные, пока шла генерация: файлы — в мусор, ничего не отправим
      const fresh = await models.GenerationRequest.findById(requestId, { deletedAt: 1 });
      if (fresh && fresh.deletedAt) {
        await storage.deleteRequestArtifacts({ requestId, paths: requestPaths(request) });
        logger.info({ requestId }, 'artifacts dropped: user data deleted during generation');
      }
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
    // 402/401 — деньги или ключ: все клиенты будут падать, салон должен узнать сразу
    if (['provider_credits', 'provider_auth'].includes(request.error.code)) {
      logger.error(
        { requestId, code: request.error.code },
        'OPERATIONAL ALERT: bfl credits exhausted or api key invalid — generation will keep failing until fixed'
      );
    }
    return { ok: false, request };
  };

  const requestPaths = (request) => [
    request.sourcePhoto && request.sourcePhoto.storagePath,
    ...(request.variants || []).map((v) => v.storagePath),
  ].filter(Boolean);

  // S7: рестарт во время генерации. Очередь in-process — на старте она пуста,
  // поэтому «висящих» queued/processing быть не может: помечаем все (без порога
  // давности, ревью 3e35882, риск 3) и возвращаем userId для уведомления клиентов.
  const recoverInterrupted = async () => {
    const stuck = await models.GenerationRequest.find(
      { status: { $in: [REQUEST_STATUS.QUEUED, REQUEST_STATUS.PROCESSING] } },
      { userId: 1 }
    ).lean();
    if (stuck.length > 0) {
      await models.GenerationRequest.updateMany(
        { status: { $in: [REQUEST_STATUS.QUEUED, REQUEST_STATUS.PROCESSING] } },
        {
          $set: {
            status: REQUEST_STATUS.ERROR,
            error: { code: ERROR_CODE.INTERNAL, message: 'interrupted by restart', retried: false },
          },
        }
      );
      // пользователи не должны остаться в processing без живого трекинга
      await models.User.updateMany(
        { 'dialogState.step': DIALOG_STEP.PROCESSING },
        { $set: { 'dialogState.step': DIALOG_STEP.IDLE } }
      );
      logger.warn({ count: stuck.length }, 'recovered interrupted requests');
    }
    return [...new Set(stuck.map((r) => String(r.userId)))];
  };

  const lastDoneRequest = (userId) =>
    models.GenerationRequest.findOne({ userId, status: REQUEST_STATUS.DONE }).sort({ createdAt: -1 });

  // Для «Повторить» после ошибки (ревью 308372d, риск 7): последний актуальный
  // запрос пользователя — включая упавший, а не только успешный
  const lastRetryableRequest = (userId) =>
    models.GenerationRequest
      .findOne({ userId, deletedAt: null, status: { $ne: REQUEST_STATUS.BUDGET_STOPPED } })
      .sort({ createdAt: -1 });

  return {
    submitRequest,
    processRequest,
    recoverInterrupted,
    lastDoneRequest,
    lastRetryableRequest,
    spentTodayUsd,
  };
};

module.exports = {
  createGenerationService,
  isRetryableError,
};
