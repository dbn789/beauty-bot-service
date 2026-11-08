// Разбор формы тестового стенда в тело запроса BFL.
// Схема полей — OpenAPI https://api.eu.bfl.ai (Flux2Inputs / Flex / Klein).
const { buildHairstylePrompt, REQUEST_STATUS, REQUEST_SOURCE } = require('@beauty/shared');
const { checkDownloadedPhoto } = require('../helpers/validation');
const { BFL_MODELS, RESOLUTIONS, fitOutputSize } = require('./providers/bfl');

const OUTPUT_FORMATS = Object.freeze(['jpeg', 'png']);

const findModel = (id) => BFL_MODELS.find((model) => model.id === id) || null;
const findResolution = (id) => RESOLUTIONS.find((item) => item.id === id) || null;

const catalog = (currentModel) => ({
  currentModel: findModel(currentModel) ? currentModel : 'flux-2-pro',
  variants: 3,
  models: BFL_MODELS.map((model) => ({
    id: model.id,
    title: model.title,
    note: model.note,
    priceUsd: model.priceUsd,
    controls: model.controls,
  })),
  resolutions: RESOLUTIONS.map((item) => ({
    id: item.id,
    title: item.title,
    megapixels: item.megapixels,
  })),
  defaultPrompt: buildHairstylePrompt({ request: 'каре до подбородка' }),
});

const intIn = (raw, min, max) => {
  const text = String(raw == null ? '' : raw).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  if (value < min || value > max) return null;
  return value;
};

const numberIn = (raw, min, max) => {
  const text = String(raw == null ? '' : raw).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (value < min || value > max) return null;
  return value;
};

// fields — строки формы, file — { mime, buffer }.
// Возвращает { error } либо готовый request для BflProvider.generate.
const parseStandRequest = (fields, file) => {
  const model = findModel(fields.model);
  if (!model) return { error: 'Выберите модель из списка BFL' };

  const variants = intIn(fields.variants, 1, 4);
  if (variants == null) return { error: 'Количество изображений — целое от 1 до 4' };

  const prompt = String(fields.prompt || '').trim().slice(0, 4000);
  if (!prompt) return { error: 'Нужен текст запроса' };

  const resolution = findResolution(fields.resolution || '2mp');
  if (!resolution) return { error: 'Выберите размер выхода' };

  if (!file || !file.buffer || !file.buffer.length) return { error: 'Загрузите исходное фото' };
  const mime = file.mime === 'image/png' ? 'image/png' : 'image/jpeg';
  if (!['image/jpeg', 'image/png'].includes(file.mime)) {
    return { error: 'Фото должно быть JPEG или PNG' };
  }
  const photo = checkDownloadedPhoto(file.buffer);
  if (!photo.ok) {
    const reason = photo.reason === 'too_small'
      ? 'Меньшая сторона фото меньше 512 пикселей'
      : 'Фото должно быть от 30 КБ до 10 МБ, JPEG или PNG';
    return { error: reason };
  }

  const outputFormat = OUTPUT_FORMATS.includes(fields.outputFormat) ? fields.outputFormat : 'jpeg';
  const safety = fields.safetyTolerance == null || fields.safetyTolerance === ''
    ? 2
    : intIn(fields.safetyTolerance, 0, 5);
  if (safety == null) return { error: 'safety_tolerance — целое от 0 до 5' };

  let seed = null;
  if (String(fields.seed || '').trim() !== '') {
    seed = intIn(fields.seed, 0, 2147483647);
    if (seed == null) return { error: 'Seed — целое от 0 до 2147483647 или пусто' };
  }

  const size = fitOutputSize(file.buffer, resolution.pixels);
  if (!size.width) return { error: 'Не удалось прочитать размер фото' };

  const controls = new Set(model.controls);
  const apiFields = {
    safety_tolerance: safety,
    output_format: outputFormat,
  };
  if (seed != null) apiFields.seed = seed;
  const keepPrompt = fields.keepPrompt === '1' || fields.keepPrompt === 'on';
  if (keepPrompt && controls.has('disablePup')) apiFields.disable_pup = true;
  if (keepPrompt && controls.has('promptUpsampling')) apiFields.prompt_upsampling = false;

  let guidance = null;
  let steps = null;
  if (controls.has('guidance')) {
    guidance = fields.guidance == null || fields.guidance === '' ? 5 : numberIn(fields.guidance, 1.5, 10);
    if (guidance == null) return { error: 'guidance — число от 1.5 до 10' };
    apiFields.guidance = guidance;
  }
  if (controls.has('steps')) {
    steps = fields.steps == null || fields.steps === '' ? 50 : intIn(fields.steps, 1, 50);
    if (steps == null) return { error: 'steps — целое от 1 до 50' };
    apiFields.steps = steps;
  }

  const megapixels = (size.width * size.height) / 1000000;
  const estimateUsd = Math.round(model.priceUsd * megapixels * variants * 1000) / 1000;

  return {
    value: {
      imageBuffer: file.buffer,
      mime,
      prompt,
      variants,
      request: { model: model.id, width: size.width, height: size.height, fields: apiFields },
      form: {
        model: model.id,
        variants,
        prompt,
        resolution: resolution.id,
        seed: seed == null ? '' : String(seed),
        outputFormat,
        safetyTolerance: safety,
        keepPrompt,
        guidance: guidance == null ? '' : String(guidance),
        steps: steps == null ? '' : String(steps),
      },
      estimateUsd,
      modelTitle: model.title,
      sourceSize: photo.meta,
    },
  };
};

// То, что реально ушло в BFL, без input_image. На ошибке — то, что собирались отправить.
const standBflRecord = (built, result) => {
  const sent = (result && result.request) || {
    prompt: built.prompt,
    ...(built.request.width ? { width: built.request.width, height: built.request.height } : {}),
    ...(built.request.fields || {}),
  };
  return {
    model: (result && result.model) || built.request.model,
    variants: built.variants,
    resolution: built.form.resolution,
    ...sent,
  };
};

// Та же коллекция, что у бота: журнал, превью и ретеншн подхватывают запись сами.
const journalStand = async ({ models, storage, built, result, error, started, day }) => {
  const doc = await models.GenerationRequest.create({
    status: REQUEST_STATUS.PROCESSING,
    source: REQUEST_SOURCE.STAND,
    userText: built.prompt,
    finalPrompt: built.prompt,
    sourcePhoto: {
      storagePath: 'pending',
      mime: built.mime,
      bytes: built.imageBuffer.length,
      width: built.sourceSize ? built.sourceSize.width : null,
      height: built.sourceSize ? built.sourceSize.height : null,
    },
    provider: 'bfl',
    model: built.request.model,
    bflRequest: standBflRecord(built, null),
    day,
  });
  const ext = built.mime === 'image/png' ? 'png' : 'jpg';
  doc.sourcePhoto.storagePath = await storage.saveSource({
    userId: `stand-${doc._id}`,
    ext,
    buffer: built.imageBuffer,
  });
  if (result) {
    const perVariant = built.variants ? built.estimateUsd / built.variants : 0;
    const variants = [];
    for (let i = 0; i < result.images.length; i += 1) {
      const image = result.images[i];
      variants.push({
        storagePath: await storage.saveVariant({
          requestId: String(doc._id),
          index: i,
          buffer: image.buffer,
        }),
        providerTaskId: image.providerTaskId || null,
        width: image.width || null,
        height: image.height || null,
        costUsd: Math.round(perVariant * 1000) / 1000,
      });
    }
    doc.variants = variants;
    doc.status = REQUEST_STATUS.DONE;
    doc.completedAt = new Date();
  } else {
    doc.status = REQUEST_STATUS.ERROR;
    doc.error = {
      code: (error && error.code) || 'provider_error',
      message: (error && error.message) || 'BFL не ответил',
      retried: false,
    };
  }
  if (result && result.request) doc.bflRequest = standBflRecord(built, result);
  doc.durationMs = Date.now() - started;
  await doc.save();
  return doc;
};

module.exports = {
  catalog,
  parseStandRequest,
  journalStand,
};
