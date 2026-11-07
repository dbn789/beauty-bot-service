// Интеграционные тесты Internal API бота (ТЗ 9.1): auth, агрегаты, журнал, файлы.
process.env.LOG_LEVEL = 'silent';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { User, GenerationRequest, REQUEST_STATUS } = require('@beauty/shared');
const { createApp } = require('../app');
const { createFileStorage } = require('../storage/files');
const { buildPng } = require('../generation/providers/png');
const { createLogger } = require('../logger');
const { moscowDayKey } = require('../helpers/day');

jest.setTimeout(120000);

const logger = createLogger({ env: 'test' });
const API_KEY = 'test-internal-key';
const noise = (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y + 11) % 256];

let mongod;
let storage;
let server;
let baseUrl;

const makeApp = (configOverrides = {}) => {
  const app = createApp({
    logger,
    dbState: () => 'ok',
    provider: 'bfl',
    botReady: () => true,
    config: {
      internalApiKey: API_KEY,
      dailyBudgetUsd: 5,
      bflModel: 'flux-2-pro',
      variants: 3,
      dailyLimit: 3,
      retentionDays: 30,
      ...configOverrides,
    },
    models: { User, GenerationRequest },
    storage,
  });
  return app;
};

const authed = (path) => fetch(`${baseUrl}${path}`, { headers: { 'x-api-key': API_KEY } });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('beauty_api_test'));
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beauty-api-'));
  storage = createFileStorage({ dataDir: tmpDir, logger });
  await storage.init();

  // фиксатура: два пользователя, три запроса (2 done + 1 error), файлы на диске
  const alice = await User.create({ tgId: 101, firstName: 'Алиса' });
  const bob = await User.create({ tgId: 202, firstName: 'Боб' });
  const today = moscowDayKey();
  const yesterday = moscowDayKey(new Date(Date.now() - 24 * 3600 * 1000));

  const makeRequest = async (user, day, status, presetCode) => {
    const request = await GenerationRequest.create({
      userId: user._id,
      status,
      source: presetCode ? 'preset' : 'free_text',
      presetCode,
      userText: presetCode ? null : 'хочу каре',
      finalPrompt: 'Edit the hairstyle: test',
      sourcePhoto: { storagePath: 'sources/u/missing.jpg', tgFileId: 'tg1', mime: 'image/jpeg', bytes: 1 },
      day,
    });
    if (status === REQUEST_STATUS.DONE) {
      const paths = [];
      for (let i = 0; i < 3; i += 1) {
        paths.push(await storage.saveVariant({
          requestId: String(request._id),
          index: i,
          buffer: buildPng(8, 8, noise),
        }));
      }
      request.variants = paths.map((p) => ({ storagePath: p, costUsd: 0.045 }));
    }
    if (status === REQUEST_STATUS.ERROR) {
      request.error = { code: 'provider_error', message: 'fixture failure', retried: true };
    }
    await request.save();
    return request;
  };

  global.__alice = alice;
  global.__bob = bob;
  global.__today = today;
  global.__yesterday = yesterday;
  global.__doneToday = await makeRequest(alice, today, REQUEST_STATUS.DONE, 'bob_classic');
  global.__doneYesterday = await makeRequest(bob, yesterday, REQUEST_STATUS.DONE, 'bob_classic');
  global.__errorToday = await makeRequest(alice, today, REQUEST_STATUS.ERROR, null);

  const app = makeApp();
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('auth (FR-I-030)', () => {
  test('без ключа — 401; с неверным — 401; /health — без ключа', async () => {
    expect((await fetch(`${baseUrl}/api/stats`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/stats`, { headers: { 'x-api-key': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  test('ключ не задан — маршруты закрыты (fail-closed)', async () => {
    const app = makeApp({ internalApiKey: '' });
    const srv = app.listen(0);
    await new Promise((resolve) => srv.on('listening', resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const response = await fetch(`${url}/api/stats`, { headers: { 'x-api-key': 'anything' } });
    expect(response.status).toBe(503);
    await new Promise((resolve) => srv.close(resolve));
  });
});

describe('/api/stats (FR-A-030)', () => {
  test('агрегаты за период: 3 запроса, 2 done, 1 error, 2 пользователя, расход', async () => {
    const response = await authed('/api/stats?days=7');
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.period.days).toBe(7);
    expect(body.totals.requests).toBe(3);
    expect(body.totals.done).toBe(2);
    expect(body.totals.errors).toBe(1);
    expect(body.totals.errorRate).toBe(33);
    expect(body.totals.users).toBe(2);
    expect(body.totals.spentUsd).toBeCloseTo(0.27, 3); // 6 вариантов × $0.045

    expect(body.budgetToday.spentUsd).toBeCloseTo(0.135, 3);
    expect(body.budgetToday.limitUsd).toBe(5);

    const todayRow = body.byDay.find((row) => row.day === global.__today);
    expect(todayRow.total).toBe(2);
    expect(todayRow.done).toBe(1);
    expect(todayRow.users).toBe(1);

    expect(body.topPresets[0]).toMatchObject({ code: 'bob_classic', count: 2 });
    expect(body.meta.provider).toBe('bfl');
    expect(body.meta.model).toBe('flux-2-pro');
    expect(body.meta.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

describe('/api/generations (FR-A-040)', () => {
  test('список с пагинацией и данными пользователей', async () => {
    const response = await authed('/api/generations?limit=2&page=1');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(3);
    expect(body.pages).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].user.firstName).toBeDefined();
    expect(body.items.some((i) => i.variantsCount === 3)).toBe(true);
  });

  test('фильтр по статусу', async () => {
    const body = await (await authed('/api/generations?status=error')).json();
    expect(body.total).toBe(1);
    expect(body.items[0].status).toBe('error');
    expect(body.items[0].error).toBeTruthy();
  });

  test('неверный статус игнорируется (не 500)', async () => {
    const body = await (await authed('/api/generations?status=nonsense')).json();
    expect(body.total).toBe(3);
  });
});

describe('/files/:id (FR-A-060)', () => {
  test('вариант v1 отдаётся как PNG, source — по kind=source', async () => {
    const v1 = await authed(`/files/${global.__doneToday._id}?v=1`);
    expect(v1.status).toBe(200);
    expect(v1.headers.get('content-type')).toBe('image/png');
    const buffer = Buffer.from(await v1.arrayBuffer());
    expect(buffer[1]).toBe(0x50); // PNG

    // source у doneToday указывает на несуществующий путь → 404
    const source = await authed(`/files/${global.__doneToday._id}?kind=source`);
    expect(source.status).toBe(404);
  });

  test('битная ссылка и чужой id — 400/404', async () => {
    expect((await authed(`/files/${global.__doneToday._id}`)).status).toBe(400);
    expect((await authed('/files/000000000000000000000000?v=1')).status).toBe(404);
  });
});

describe('/api/stand', () => {
  test('мета, генерация без записи в журнал, 503 без провайдера', async () => {
    const meta = await authed('/api/stand');
    expect(meta.status).toBe(200);
    const catalog = await meta.json();
    expect(catalog.models.some((model) => model.id === 'flux-2-max')).toBe(true);

    const calls = [];
    const photo = buildPng(640, 800, noise);
    const app = createApp({
      logger,
      dbState: () => 'ok',
      provider: 'bfl',
      config: { internalApiKey: API_KEY, bflModel: 'flux-2-pro', variants: 3 },
      models: { User, GenerationRequest },
      storage,
      bflProvider: {
        async generate(input) {
          calls.push(input);
          return {
            model: input.request.model,
            request: { prompt: input.prompt, width: input.request.width, disable_pup: true },
            images: [{ buffer: photo, width: input.request.width, height: input.request.height, providerTaskId: 't' }],
          };
        },
      },
    });
    const srv = app.listen(0);
    await new Promise((resolve) => srv.on('listening', resolve));
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const url = `${origin}/api/stand`;
    const before = await GenerationRequest.countDocuments();
    const boundary = 'standb';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nflux-2-max\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="variants"\r\n\r\n1\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nkeep the face\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="resolution"\r\n\r\n2mp\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="keepPrompt"\r\n\r\n1\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      photo,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.model).toBe('flux-2-max');
    expect(json.images).toHaveLength(1);
    expect(calls[0].request.fields.disable_pup).toBe(true);
    expect(await GenerationRequest.countDocuments()).toBe(before + 1);
    const saved = await GenerationRequest.findOne({ source: 'stand' }).lean();
    expect(saved.status).toBe('done');
    expect(saved.model).toBe('flux-2-max');
    expect(saved.userId).toBeNull();
    expect(saved.finalPrompt).toBe('keep the face');
    expect(saved.variants).toHaveLength(1);

    const journal = await (await fetch(`${origin}/api/generations`, {
      headers: { 'x-api-key': API_KEY },
    })).json();
    const row = journal.items.find((item) => item.source === 'stand');
    expect(row.user.firstName).toBe('Стенд');
    expect(row.model).toBe('flux-2-max');
    expect((await fetch(`${origin}/files/${saved._id}?kind=source`, {
      headers: { 'x-api-key': API_KEY },
    })).status).toBe(200);

    const closed = await fetch(`${baseUrl}/api/stand`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'content-type': 'multipart/form-data; boundary=x' },
      body: Buffer.from('--x--\r\n'),
    });
    expect(closed.status).toBe(503);
    await new Promise((resolve) => srv.close(resolve));
  });
});
