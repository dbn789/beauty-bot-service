// Интеграционные сценарии (ТЗ, раздел 10): полный флоу через MockProvider + S2–S7
// + регрессии на находки ревью 3e35882 (копия исходника, ПДн-зачистка, бюджет in-flight, queue busy).
process.env.LOG_LEVEL = 'silent';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  User, GenerationRequest, REQUEST_STATUS, DIALOG_STEP, PRESETS_CATALOG,
} = require('@beauty/shared');
const { createFileStorage } = require('../storage/files');
const { createRetention } = require('../storage/retention');
const { LimiterQueue } = require('../generation/queue');
const { createGenerationService } = require('../generation/service');
const { MockProvider } = require('../generation/providers/mock');
const { buildPng } = require('../generation/providers/png');
const { createLogger } = require('../logger');

jest.setTimeout(120000); // первый запуск качает mongod-бинарь

const logger = createLogger({ env: 'test' });

let mongod;
let storage;
let tmpDir;

const noise = (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y + 11) % 256];

// «Платный» провайдер с ценами bfl/flux-2-klein-9b ($0.015/вариант) для бюджетных кейсов
const makePaidProvider = ({ delayMs = 0 } = {}) => ({
  name: 'bfl',
  model: 'flux-2-klein-9b',
  async generate({ variants = 3 } = {}) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      model: 'flux.2-flex',
      images: Array.from({ length: variants }, (_v, i) => ({
        buffer: buildPng(8, 8, noise),
        width: 8,
        height: 8,
        providerTaskId: `paid-${i}`,
      })),
    };
  },
  async health() { return true; },
});

const makeService = ({ provider = new MockProvider({ delayMs: 5 }), config: overrides = {} } = {}) =>
  createGenerationService({
    models: { User, GenerationRequest },
    storage,
    provider,
    config: {
      variants: 3,
      dailyLimit: 3,
      dailyBudgetUsd: 5,
      generationTimeoutMs: 5000,
      generationConcurrency: 2,
      retentionDays: 30,
      maxQueueSize: 50,
      ...overrides,
    },
    logger,
    queue: new LimiterQueue({ concurrency: 2 }),
  });

const makeUser = async (extra = {}) =>
  User.create({ tgId: Math.floor(Math.random() * 1e9), ...extra });

// Реальный файл в хранилище — сервис теперь копирует исходник на каждый запрос
const seedPhoto = async (user) => {
  const buffer = buildPng(700, 700, noise);
  const storagePath = await storage.saveSource({ userId: user._id, ext: 'png', buffer });
  return {
    storagePath,
    tgFileId: 'tg-file-1',
    mime: 'image/png',
    bytes: buffer.length,
    width: 700,
    height: 700,
    uploadedAt: new Date(),
  };
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('beauty_test'));
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beauty-it-'));
  storage = createFileStorage({ dataDir: tmpDir, logger });
  await storage.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('основной сценарий: фото → пресет → 3 варианта', () => {
  test('успешная генерация по пресету (FR-G-020/030/050/070/110)', async () => {
    const service = makeService();
    const user = await makeUser();
    const photo = await seedPhoto(user);
    const preset = PRESETS_CATALOG[0];

    const result = await service.submitRequest({ user, photo, source: 'preset', preset });
    expect(result.requestId).toBeDefined();

    const outcome = await result.promise;
    expect(outcome.ok).toBe(true);

    const request = await GenerationRequest.findById(result.requestId);
    expect(request.status).toBe(REQUEST_STATUS.DONE);
    expect(request.variants).toHaveLength(3);
    expect(request.finalPrompt).toContain(preset.promptEn);
    expect(request.finalPrompt).toContain('exactly the same as the reference photo');
    expect(request.durationMs).toBeGreaterThan(0);
    expect(request.completedAt).not.toBeNull();

    // у запроса собственная копия исходника (ревью, риск 5), оригинал не тронут
    expect(request.sourcePhoto.storagePath).not.toBe(photo.storagePath);
    expect(await storage.exists(request.sourcePhoto.storagePath)).toBe(true);
    expect(await storage.exists(photo.storagePath)).toBe(true);

    for (const variant of request.variants) {
      expect(await storage.exists(variant.storagePath)).toBe(true);
    }

    const updated = await User.findById(user._id);
    expect(updated.generationsTotal).toBe(1);
  });

  test('успешная генерация по свободному тексту (FR-G-040)', async () => {
    const service = makeService();
    const user = await makeUser();
    const photo = await seedPhoto(user);
    const result = await service.submitRequest({
      user, photo, source: 'free_text', userText: 'short red bob with bangs',
    });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(true);
    expect(outcome.request.finalPrompt).toContain('short red bob with bangs');
  });

  test('повтор по старому запросу работает после новой загрузки фото (more:last, риск 5)', async () => {
    const service = makeService();
    const user = await makeUser();
    const photo1 = await seedPhoto(user);

    const first = await service.submitRequest({ user, photo: photo1, source: 'free_text', userText: 'first' });
    const firstOutcome = await first.promise;
    expect(firstOutcome.ok).toBe(true);

    // пользователь загрузил новое фото — файл photo1 на диске заменён
    const photo2 = await seedPhoto(user);
    expect(await storage.exists(photo2.storagePath)).toBe(true);

    // но «Ещё варианты» по первому запросу берёт его собственную копию
    const second = await service.submitRequest({
      user,
      photo: firstOutcome.request.sourcePhoto,
      source: 'free_text',
      userText: 'first',
    });
    const secondOutcome = await second.promise;
    expect(secondOutcome.ok).toBe(true);
  });

  test('нет файла исходника — invalidPhoto, а не молчаливая порча', async () => {
    const service = makeService();
    const user = await makeUser();
    const ghost = { storagePath: 'sources/u/missing.png', tgFileId: 'x', mime: 'image/png', bytes: 1 };
    const result = await service.submitRequest({ user, photo: ghost, source: 'free_text', userText: 'no file' });
    expect(result.invalidPhoto).toBe(true);
    const request = await GenerationRequest.findById(result.requestId);
    expect(request.status).toBe(REQUEST_STATUS.ERROR);
    expect(request.error.code).toBe('validation');
  });
});

describe('S2: суточный лимит (FR-B-080)', () => {
  test('после дневного лимита — limited, без создания запроса', async () => {
    const service = makeService({ config: { dailyLimit: 1 } });
    const user = await makeUser();
    const photo = await seedPhoto(user);

    const first = await service.submitRequest({ user, photo, source: 'free_text', userText: 'first' });
    expect((await first.promise).ok).toBe(true);

    const second = await service.submitRequest({ user, photo, source: 'free_text', userText: 'second' });
    expect(second.limited).toBe(true);
    expect(second.requestId).toBeUndefined();
  });

  test('выполняющийся запрос списывается из лимита: обход через /cancel закрыт (308372d риск 1)', async () => {
    const provider = new MockProvider({ delayMs: 250 });
    const service = makeService({ provider, config: { dailyLimit: 1 } });
    const user = await makeUser();
    const photo = await seedPhoto(user);

    const first = await service.submitRequest({ user, photo, source: 'free_text', userText: 'a' });
    expect(first.promise).toBeDefined(); // queued/processing — уже списан

    const second = await service.submitRequest({ user, photo, source: 'free_text', userText: 'b' });
    expect(second.limited).toBe(true);

    expect((await first.promise).ok).toBe(true);
  });
});

describe('S4: дневной бюджет-стоп (FR-G-080)', () => {
  test('при нехватке бюджета запрос не уходит провайдеру', async () => {
    let providerCalled = false;
    const provider = makePaidProvider();
    provider.generate = async () => {
      providerCalled = true;
      throw new Error('must not be called');
    };
    // 3 варианта × $0.015 = $0.045 > бюджета $0.01
    const service = makeService({ provider, config: { dailyBudgetUsd: 0.01 } });
    const user = await makeUser();
    const photo = await seedPhoto(user);

    const result = await service.submitRequest({ user, photo, source: 'free_text', userText: 'budget' });
    expect(result.budgetStopped).toBe(true);
    expect(providerCalled).toBe(false);
    expect((await GenerationRequest.findById(result.requestId)).status)
      .toBe(REQUEST_STATUS.BUDGET_STOPPED);
  });

  test('учитываются запросы в очереди, а не только завершённые (риск 2)', async () => {
    const provider = makePaidProvider({ delayMs: 250 });
    // бюджет $0.05: первая отправка 1×$0.045 проходит, вторая (1 in-flight + 1)×$0.045 — нет
    const service = makeService({ provider, config: { dailyBudgetUsd: 0.05 } });
    const user = await makeUser();
    const photo = await seedPhoto(user);

    const first = await service.submitRequest({ user, photo, source: 'free_text', userText: 'a' });
    expect(first.promise).toBeDefined();

    const second = await service.submitRequest({ user, photo, source: 'free_text', userText: 'b' });
    expect(second.budgetStopped).toBe(true);

    expect((await first.promise).ok).toBe(true);
  });
});

describe('queue busy: защита от переполнения очереди', () => {
  test('при полной очереди — busy, без создания нового запроса', async () => {
    const provider = new MockProvider({ delayMs: 250 });
    // dailyLimit выше числа отправок: проверяем именно очередь, а не лимит
    const service = makeService({ provider, config: { maxQueueSize: 1, dailyLimit: 10 } });
    const user = await makeUser();
    const photo = await seedPhoto(user);

    const accepted = [];
    for (const text of ['a', 'b', 'c', 'd']) {
      const result = await service.submitRequest({ user, photo, source: 'free_text', userText: text });
      if (result.promise) accepted.push(result.promise);
      else expect(result.busy).toBe(true);
    }
    // concurrency 2 + очередь 1 = принято 3, четвёртый — busy
    expect(accepted).toHaveLength(3);
    expect(await Promise.all(accepted)).toHaveLength(3);
  });
});

describe('S3: ошибки провайдера и ретраи (FR-G-060)', () => {
  test('первая ошибка, повтор успешен', async () => {
    const provider = new MockProvider({ delayMs: 5, failFirstN: 1 });
    const service = makeService({ provider });
    const user = await makeUser();
    const photo = await seedPhoto(user);

    const result = await service.submitRequest({ user, photo, source: 'free_text', userText: 'retry me' });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(true);
    expect(provider.calls).toBe(2);
  });

  test('обе попытки неудачны — статус error с retried=true', async () => {
    const provider = new MockProvider({ delayMs: 5, failFirstN: 2 });
    const service = makeService({ provider });
    const user = await makeUser();
    const photo = await seedPhoto(user);

    const result = await service.submitRequest({ user, photo, source: 'free_text', userText: 'fail me' });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(false);

    const request = await GenerationRequest.findById(result.requestId);
    expect(request.status).toBe(REQUEST_STATUS.ERROR);
    expect(request.error.code).toBe('provider_error');
    expect(request.error.retried).toBe(true);
  });
});

describe('S7: восстановление после рестарта (риск 3)', () => {
  test('все висящие queued/processing → error, шаги пользователей сброшены, userIds возвращены', async () => {
    const service = makeService();
    const user = await makeUser({ dialogState: { step: DIALOG_STEP.PROCESSING } });
    const photo = await seedPhoto(user);

    const queued = await GenerationRequest.create({
      userId: user._id,
      status: REQUEST_STATUS.QUEUED, // свежий, без «старения» — на старте очереди нет
      source: 'free_text',
      finalPrompt: 'interrupted',
      sourcePhoto: photo,
      day: '2026-01-01',
    });
    expect(queued.status).toBe(REQUEST_STATUS.QUEUED);

    const affected = await service.recoverInterrupted();
    expect(affected).toEqual([String(user._id)]);

    const request = await GenerationRequest.findById(queued._id);
    expect(request.status).toBe(REQUEST_STATUS.ERROR);
    expect(request.error.message).toBe('interrupted by restart');

    const after = await User.findById(user._id);
    expect(after.dialogState.step).toBe(DIALOG_STEP.IDLE);
  });
});

describe('ретеншн и удаление данных (FR-I-080, FR-B-100, NFR-05)', () => {
  const makeRetention = () =>
    createRetention({
      models: { User, GenerationRequest }, storage,
      config: { retentionDays: 30 }, logger,
    });

  test('deleteExpired удаляет файлы, помечает deletedAt и зачищает ПДн (риск 6)', async () => {
    const service = makeService();
    const user = await makeUser();
    const photo = await seedPhoto(user);
    const result = await service.submitRequest({ user, photo, source: 'free_text', userText: 'secret wish' });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(true);
    const variantPath = outcome.request.variants[0].storagePath;
    expect(await storage.exists(variantPath)).toBe(true);

    const touched = await makeRetention().deleteExpired(new Date(Date.now() + 31 * 24 * 3600 * 1000));
    expect(touched).toBeGreaterThanOrEqual(1);

    expect(await storage.exists(variantPath)).toBe(false);
    const request = await GenerationRequest.findById(result.requestId);
    expect(request.deletedAt).not.toBeNull();
    // ПДн зачищены: по tgFileId фото можно было скачать заново из Telegram
    expect(request.sourcePhoto.tgFileId).toBeNull();
    expect(request.userText).toBeNull();
    expect(request.finalPrompt).toBe('—');
  });

  test('deleteUserData (S6) чистит запросы, файлы, dialogState и ПДн', async () => {
    const service = makeService();
    const user = await makeUser();
    const photo = await seedPhoto(user);
    const result = await service.submitRequest({ user, photo, source: 'free_text', userText: 'mine' });
    expect((await result.promise).ok).toBe(true);

    await User.updateOne({ _id: user._id }, { $set: { 'dialogState.photo': photo } });

    const fresh = await User.findById(user._id);
    const stats = await makeRetention().deleteUserData(fresh);
    expect(stats.requests).toBe(1);
    expect(stats.files).toBeGreaterThanOrEqual(2); // копия исходника + варианты

    const after = await User.findById(user._id);
    expect(after.dataDeletedAt).not.toBeNull();
    expect(after.dialogState.photo.storagePath).toBeNull();
    expect(after.dialogState.step).toBe(DIALOG_STEP.IDLE);

    const request = await GenerationRequest.findById(result.requestId);
    expect(request.deletedAt).not.toBeNull();
    expect(request.sourcePhoto.tgFileId).toBeNull();
    expect(request.userText).toBeNull();
  });

  test('болтающееся dialogState-фото без генерации вычищается через сутки (риск 6)', async () => {
    const user = await makeUser();
    const stalePhoto = await seedPhoto(user);
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          'dialogState.step': DIALOG_STEP.AWAIT_CHOICE,
          'dialogState.photo': { ...stalePhoto, uploadedAt: new Date(Date.now() - 25 * 3600 * 1000) },
        },
      }
    );

    const cleaned = await makeRetention().deleteStaleDialogPhotos();
    expect(cleaned).toBe(1);

    const after = await User.findById(user._id);
    expect(after.dialogState.photo.storagePath).toBeNull();
    expect(after.dialogState.step).toBe(DIALOG_STEP.IDLE);
    expect(await storage.exists(stalePhoto.storagePath)).toBe(false);
  });
});
