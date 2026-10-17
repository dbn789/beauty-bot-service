// Интеграционные тесты beauty-admin: bootstrap-учётка, login, auth-wall, страницы.
process.env.LOG_LEVEL = 'silent';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const { AdminUser, User: BotUser, GenerationRequest } = require('@beauty/shared');
const { createSession } = require('../helpers/session');
const { createAdminApp } = require('../src/app');

jest.setTimeout(120000);

const logger = { error: () => {} };

let mongod;
let server;
let baseUrl;
let cookie;

// фейковый клиент Internal API бота: дашборд/журнал без реального бота
const fakeBot = {
  statsCalls: 0,
  async stats(days) {
    this.statsCalls += 1;
    return {
      period: { days },
      totals: { requests: 5, done: 4, errors: 1, errorRate: 20, users: 2, spentUsd: 0.54 },
      budgetToday: { spentUsd: 0.135, limitUsd: 5 },
      byDay: [{ day: '2026-10-12', total: 5, done: 4, error: 1, users: 2, spent: 0.54 }],
      topPresets: [{ code: 'bob_classic', count: 3, title: '💇‍♀️ Классическое каре' }],
      meta: { app: 'beauty-bot', version: '0.1.0', provider: 'bfl', model: 'flux-2-pro' },
    };
  },
  async generations() {
    return {
      total: 1, page: 1, limit: 20, pages: 1,
      items: [{
        id: '507f1f77bcf86cd799439011', createdAt: new Date(), day: '2026-10-12',
        status: 'done', source: 'preset', presetCode: 'bob_classic', userText: null,
        durationMs: 25000, error: null, variantsCount: 3, deletedAt: null,
        user: { tgId: 12345, firstName: 'Тест', username: null },
      }],
    };
  },
  async file() {
    throw new Error('bot api /files: http 404');
  },
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('beauty_admin_test'));

  await AdminUser.create({ login: 'boss', passwordHash: await bcrypt.hash('supersecret', 10) });
  await BotUser.create({ tgId: 12345, firstName: 'Тест' });

  const app = createAdminApp({
    session: createSession('test-secret-at-least-16-chars'),
    bot: fakeBot,
    models: { AdminUser, BotUser, GenerationRequest },
    config: { env: 'development', dbState: () => 'ok' },
    logger,
  });
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('auth-wall (FR-A-010/020)', () => {
  test('без сессии любые страницы редиректят на /login, /health открыт', async () => {
    const dashboard = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
    expect(dashboard.status).toBe(302);
    expect(dashboard.headers.get('location')).toBe('/login');

    expect((await fetch(`${baseUrl}/login`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  test('неверный пароль — 401 с сообщением', async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'login=boss&password=wrong',
    });
    expect(response.status).toBe(401);
    expect((await response.text()).includes('Неверный логин или пароль')).toBe(true);
  });

  test('верный пароль — редирект на дашборд с cookie', async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'login=boss&password=supersecret',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');
    cookie = (response.headers.get('set-cookie') || '').split(';')[0];
    expect(cookie.startsWith('beauty_session=')).toBe(true);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });
});

describe('страницы под сессией', () => {
  const authed = (p, opts = {}) => fetch(`${baseUrl}${p}`, { headers: { cookie }, ...opts });

  test('дашборд рендерится с данными бота (FR-A-030)', async () => {
    const response = await authed('/dashboard?days=7');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.includes('Дашборд')).toBe(true);
    expect(html.includes('0.54')).toBe(true); // расход периода
    expect(html.includes('Классическое каре')).toBe(true); // топ пресет
  });

  test('журнал рендерится с фильтрами и превью-ссылками (FR-A-040)', async () => {
    const response = await authed('/generations');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.includes('done')).toBe(true);
    expect(html.includes('/preview/507f1f77bcf86cd799439011')).toBe(true);
  });

  test('пользователи из общей БД (FR-A-050)', async () => {
    const response = await authed('/users');
    expect(response.status).toBe(200);
    expect((await response.text()).includes('12345')).toBe(true);
  });

  test('превью недоступного файла → заглушка 404 (FR-A-060)', async () => {
    const response = await authed('/preview/507f1f77bcf86cd799439011?ref=v%3D1');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('svg');
  });

  test('о сервисе показывает meta бота (FR-A-070)', async () => {
    const html = await (await authed('/about')).text();
    expect(html.includes('flux-2-pro')).toBe(true);
  });

  test('logout чистит сессию', async () => {
    const response = await authed('/logout', { redirect: 'manual' });
    expect(response.status).toBe(302);
    const after = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
    expect(after.headers.get('location')).toBe('/login');
  });
});
