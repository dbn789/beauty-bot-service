// Интеграционные сценарии Э1 (ТЗ, раздел 10): полный флоу через MockProvider + S2–S7.
process.env.LOG_LEVEL = 'silent';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  User, GenerationRequest, REQUEST_STATUS, PRESETS_CATALOG,
} = require('@beauty/shared');
const { createFileStorage } = require('../storage/files');
const { createRetention } = require('../storage/retention');
const { LimiterQueue } = require('../generation/queue');
const { createGenerationService } = require('../generation/service');
const { MockProvider } = require('../generation/providers/mock');
const { createLogger } = require('../logger');

jest.setTimeout(120000); // первый запуск качает mongod-бинарь

const logger = createLogger({ env: 'test' });

let mongod;
let storage;
let tmpDir;

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
      ...overrides,
    },
    logger,
    queue: new LimiterQueue({ concurrency: 2 }),
  });

const makeUser = () => User.create({ tgId: Math.floor(Math.random() * 1e9) });

const makePhoto = () => ({
  storagePath: 'sources/u/photo.jpg',
  tgFileId: 'tg-file-1',
  mime: 'image/jpeg',
  bytes: 200 * 1024,
  width: 800,
  height: 600,
});

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
    const preset = PRESETS_CATALOG[0];

    const result = await service.submitRequest({
      user, photo: makePhoto(), source: 'preset', preset,
    });
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

    for (const variant of request.variants) {
      expect(await storage.exists(variant.storagePath)).toBe(true);
    }

    const updated = await User.findById(user._id);
    expect(updated.generationsTotal).toBe(1);
  });

  test('успешная генерация по свободному тексту (FR-G-040)', async () => {
    const service = makeService();
    const user = await makeUser();
    const result = await service.submitRequest({
      user, photo: makePhoto(), source: 'free_text', userText: 'short red bob with bangs',
    });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(true);
    expect(outcome.request.finalPrompt).toContain('short red bob with bangs');
  });
});

describe('S2: суточный лимит (FR-B-080)', () => {
  test('после дневного лимита — limited, без создания запроса', async () => {
    const service = makeService({ config: { dailyLimit: 1 } });
    const user = await makeUser();

    const first = await service.submitRequest({
      user, photo: makePhoto(), source: 'free_text', userText: 'first request',
    });
    expect((await first.promise).ok).toBe(true);

    const second = await service.submitRequest({
      user, photo: makePhoto(), source: 'free_text', userText: 'second request',
    });
    expect(second.limited).toBe(true);
    expect(second.requestId).toBeUndefined();
  });
});

describe('S4: дневной бюджет-стоп (FR-G-080)', () => {
  test('при нехватке бюджета запрос не уходит провайдеру', async () => {
    let providerCalled = false;
    const fakeBflProvider = {
      name: 'bfl',
      model: 'flux.2-flex', // оценка 0.03 × 3 варианта = 0.09 USD > бюджета 0.01
      generate: async () => {
        providerCalled = true;
        throw new Error('must not be called');
      },
    };
    const service = makeService({ provider: fakeBflProvider, config: { dailyBudgetUsd: 0.01 } });
    const user = await makeUser();

    const result = await service.submitRequest({
      user, photo: makePhoto(), source: 'free_text', userText: 'budget test',
    });
    expect(result.budgetStopped).toBe(true);
    expect(providerCalled).toBe(false);

    const request = await GenerationRequest.findById(result.requestId);
    expect(request.status).toBe(REQUEST_STATUS.BUDGET_STOPPED);
  });
});

describe('S3: ошибки провайдера и ретраи (FR-G-060)', () => {
  test('первая ошибка, повтор успешен', async () => {
    const provider = new MockProvider({ delayMs: 5, failFirstN: 1 });
    const service = makeService({ provider });
    const user = await makeUser();

    const result = await service.submitRequest({
      user, photo: makePhoto(), source: 'free_text', userText: 'retry me',
    });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(true);
    expect(provider.calls).toBe(2);
  });

  test('обе попытки неудачны — статус error с retried=true', async () => {
    const provider = new MockProvider({ delayMs: 5, failFirstN: 2 });
    const service = makeService({ provider });
    const user = await makeUser();

    const result = await service.submitRequest({
      user, photo: makePhoto(), source: 'free_text', userText: 'fail me',
    });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(false);

    const request = await GenerationRequest.findById(result.requestId);
    expect(request.status).toBe(REQUEST_STATUS.ERROR);
    expect(request.error.code).toBe('provider_error');
    expect(request.error.retried).toBe(true);
  });
});

describe('S7: восстановление после рестарта', () => {
  test('висящие queued/processing старше 5 минут → error', async () => {
    const service = makeService();
    const user = await makeUser();

    const stale = await GenerationRequest.create({
      userId: user._id,
      status: REQUEST_STATUS.PROCESSING,
      source: 'free_text',
      finalPrompt: 'interrupted',
      sourcePhoto: makePhoto(),
      day: '2026-01-01',
    });
    await GenerationRequest.collection.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }
    );

    const recovered = await service.recoverInterrupted();
    expect(recovered).toBe(1);

    const request = await GenerationRequest.findById(stale._id);
    expect(request.status).toBe(REQUEST_STATUS.ERROR);
    expect(request.error.message).toBe('interrupted by restart');
  });
});

describe('ретеншн и удаление данных (FR-I-080, FR-B-100)', () => {
  test('deleteExpired удаляет файлы и помечает deletedAt', async () => {
    const service = makeService();
    const user = await makeUser();
    const result = await service.submitRequest({
      user, photo: makePhoto(), source: 'free_text', userText: 'will expire',
    });
    const outcome = await result.promise;
    expect(outcome.ok).toBe(true);
    const variantPath = outcome.request.variants[0].storagePath;
    expect(await storage.exists(variantPath)).toBe(true);

    const retention = createRetention({
      models: { User, GenerationRequest }, storage,
      config: { retentionDays: 30 }, logger,
    });
    // подвигаем границу на 31 день вперёд — все запросы «просрочены»
    const touched = await retention.deleteExpired(new Date(Date.now() + 31 * 24 * 3600 * 1000));
    expect(touched).toBeGreaterThanOrEqual(1);

    expect(await storage.exists(variantPath)).toBe(false);
    const request = await GenerationRequest.findById(result.requestId);
    expect(request.deletedAt).not.toBeNull();
  });

  test('deleteUserData (S6) чистит запросы, файлы и dialogState', async () => {
    const service = makeService();
    const user = await makeUser();
    const photo = makePhoto();
    const result = await service.submitRequest({ user, photo, source: 'free_text', userText: 'mine' });
    expect((await result.promise).ok).toBe(true);

    await User.updateOne(
      { _id: user._id },
      { $set: { 'dialogState.photo': photo } }
    );

    const retention = createRetention({
      models: { User, GenerationRequest }, storage,
      config: { retentionDays: 30 }, logger,
    });
    const fresh = await User.findById(user._id);
    const stats = await retention.deleteUserData(fresh);
    expect(stats.requests).toBe(1);
    expect(stats.files).toBeGreaterThanOrEqual(2); // исходник + варианты

    const after = await User.findById(user._id);
    expect(after.dataDeletedAt).not.toBeNull();
    expect(after.dialogState.photo.storagePath).toBeNull();
    expect(after.dialogState.step).toBe('idle');

    const request = await GenerationRequest.findById(result.requestId);
    expect(request.deletedAt).not.toBeNull();
  });
});
