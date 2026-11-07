// Интеграционные тесты beauty-admin: bootstrap-учётка, login, auth-wall, страницы.
process.env.LOG_LEVEL = 'silent';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const { AdminUser, User: BotUser, GenerationRequest, Setting } = require('@beauty/shared');
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
      total: 2, page: 1, limit: 20, pages: 1,
      items: [{
        id: '507f1f77bcf86cd799439011', createdAt: new Date(), day: '2026-10-12',
        status: 'done', source: 'preset', presetCode: 'bob_classic', userText: null,
        durationMs: 25000, error: null, variantsCount: 3, deletedAt: null,
        user: { tgId: 12345, firstName: 'Тест', username: null },
      }, {
        id: '507f1f77bcf86cd799439012', createdAt: new Date(), day: '2026-10-12',
        status: 'done', source: 'stand', model: 'flux-2-max', presetCode: null,
        userText: 'keep the face', durationMs: 1200, error: null, variantsCount: 1,
        deletedAt: null,
        user: { firstName: 'Стенд', tgId: null, username: null },
      }],
    };
  },
  async file() {
    throw new Error('bot api /files: http 404');
  },
  async standMeta() {
    return {
      currentModel: 'flux-2-pro',
      variants: 3,
      defaultPrompt: 'Edit the hairstyle: каре. Keep the face.',
      models: [
        { id: 'flux-2-pro', title: 'FLUX.2 [pro]', note: 'модель бота', priceUsd: 0.045, controls: ['disablePup'] },
        { id: 'flux-2-flex', title: 'FLUX.2 [flex]', note: 'guidance', priceUsd: 0.06, controls: ['guidance', 'steps', 'promptUpsampling'] },
      ],
      resolutions: [
        { id: 'cap1', title: 'около 1.1 МП', megapixels: 1.1 },
        { id: '2mp', title: '2 МП', megapixels: 2 },
      ],
    };
  },
  async stand() {
    return {
      model: 'flux-2-pro',
      elapsedMs: 1200,
      estimateUsd: 0.09,
      request: { prompt: 'keep', width: 800, height: 1000, disable_pup: true },
      form: { model: 'flux-2-pro', variants: 1, prompt: 'keep', resolution: '2mp', keepPrompt: true },
      images: [{ mime: 'image/png', width: 8, height: 8, base64: 'aGk=' }],
    };
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
    models: { AdminUser, BotUser, GenerationRequest, Setting },
    config: { env: 'development', dbState: () => 'ok' },
    logger,
    deployer: {
      configured: true,
      running: false,
      lastResult: null,
      deploy: async ({ by }) => ({ ok: true, detail: 'beauty-bot: ok; beauty-admin: ok', by }),
    },
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

  test('тестовый стенд стоит в меню и показывает модели BFL', async () => {
    const html = await (await authed('/stand')).text();
    expect(html.includes('Тестовый стенд')).toBe(true);
    expect(html.includes('flux-2-pro')).toBe(true);
    expect(html.includes('flux-2-flex')).toBe(true);
    expect(html.includes('Не давать модели переписывать текст')).toBe(true);
    expect(html.includes('guidance')).toBe(true);

    const dash = await (await authed('/dashboard')).text();
    const standAt = dash.indexOf('Тестовый стенд');
    const genAt = dash.indexOf('Генерации');
    expect(standAt).toBeGreaterThan(-1);
    expect(standAt).toBeLessThan(genAt);
  });

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
    expect(html.includes('Стенд · flux-2-max')).toBe(true);
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

  describe('настройки: каркас с подтабами', () => {
    test('/settings редиректит на первый раздел', async () => {
      const response = await authed('/settings', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/settings/bot');
    });

    test('все пять подтабов открываются с планом раздела', async () => {
      for (const section of ['users', 'bot', 'generation', 'stand', 'deploy']) {
        const response = await authed(`/settings/${section}`);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html.includes('Запланировано')).toBe(true);
        expect(html.includes('Сохранить заметку')).toBe(true);
      }
    });

    test('кнопка «Задеплоить»: POST запускает деплоер и возвращает ok', async () => {
      const html0 = await (await authed('/settings/deploy')).text();
      expect(html0.includes('Задеплоить на Amvera')).toBe(true);

      const response = await fetch(`${baseUrl}/settings/deploy/run`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/settings/deploy?result=ok');

      const html = await (await authed('/settings/deploy?result=ok')).text();
      expect(html.includes('Деплой запущен успешно')).toBe(true);
    });

    test('без DEPLOY_* кнопка скрыта, показан баннер «не настроено» (ревью 4430c97, риск 2)', async () => {
      const app2 = createAdminApp({
        session: createSession('test-secret-at-least-16-chars'),
        bot: fakeBot,
        models: { AdminUser, BotUser, GenerationRequest, Setting },
        config: { env: 'development', dbState: () => 'ok' },
        logger,
        deployer: { configured: false, running: false, lastResult: null, deploy: async () => ({ ok: false }) },
      });
      const srv = app2.listen(0);
      await new Promise((resolve) => srv.on('listening', resolve));
      const url = `http://127.0.0.1:${srv.address().port}`;

      const login = await fetch(`${url}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'login=boss&password=supersecret',
      });
      const c = (login.headers.get('set-cookie') || '').split(';')[0];
      const html = await (await fetch(`${url}/settings/deploy`, { headers: { cookie: c } })).text();
      expect(html.includes('Кнопка не настроена')).toBe(true);
      expect(html.includes('DEPLOY_LOGIN')).toBe(true);
      // самой кнопки нет (фраза встречается и в план-листе, поэтому проверяем класс)
      expect(html.includes('deploy-btn')).toBe(false);

      await new Promise((resolve) => srv.close(resolve));
    });

    test('несуществующий раздел — 404', async () => {
      expect((await authed('/settings/nope')).status).toBe(404);
    });

    test('доступ к боту: режим, добавление по ID, профиль после /start, удаление', async () => {
      await BotUser.create({
        tgId: 424242, username: 'anna', firstName: 'Анна', lastName: 'Иванова',
      });

      const off = await (await authed('/settings/users')).text();
      expect(off.includes('фильтр отключен')).toBe(true);
      expect(off.includes('Добавить пользователя')).toBe(false);

      const setMode = await fetch(`${baseUrl}/settings/users/access`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'accessMode=whitelist',
      });
      expect(setMode.headers.get('location')).toBe('/settings/users?saved=1');

      const bad = await fetch(`${baseUrl}/settings/users/entries`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'tgId=abc',
      });
      expect(bad.headers.get('location')).toBe('/settings/users?error=badid');

      const add = await fetch(`${baseUrl}/settings/users/entries`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'tgId=424242',
      });
      expect(add.headers.get('location')).toBe('/settings/users?added=1');

      const html = await (await authed('/settings/users?added=1')).text();
      expect(html.includes('424242')).toBe(true);
      expect(html.includes('@anna')).toBe(true);
      expect(html.includes('Анна')).toBe(true);
      expect(html.includes('Иванова')).toBe(true);

      const again = await fetch(`${baseUrl}/settings/users/entries`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'tgId=424242',
      });
      expect(again.headers.get('location')).toBe('/settings/users?error=duplicate');

      const note = await fetch(`${baseUrl}/settings/users`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'notes=только салон',
      });
      expect(note.status).toBe(302);
      const saved = await Setting.findOne({ section: 'users' }).lean();
      expect(saved.data.notes).toBe('только салон');
      expect(saved.data.accessMode).toBe('whitelist');
      expect(saved.data.lists.whitelist).toEqual([{ tgId: 424242 }]);

      const remove = await fetch(`${baseUrl}/settings/users/entries/remove`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'tgId=424242',
      });
      expect(remove.headers.get('location')).toBe('/settings/users?removed=1');
      const after = await Setting.findOne({ section: 'users' }).lean();
      expect(after.data.lists.whitelist).toEqual([]);
      expect(after.data.lists.blacklist).toEqual([]);
    });

    test('заметка сохраняется и возвращается (round-trip через БД)', async () => {
      const post = await fetch(`${baseUrl}/settings/stand`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'notes=проверить регион перед боевым запуском',
      });
      expect(post.status).toBe(302);
      expect(post.headers.get('location')).toBe('/settings/stand?saved=1');

      const html = await (await authed('/settings/stand?saved=1')).text();
      expect(html.includes('✅ Сохранено')).toBe(true);
      expect(html.includes('проверить регион перед боевым запуском')).toBe(true);

      const doc = await Setting.findOne({ section: 'stand' }).lean();
      expect(doc.data.notes).toBe('проверить регион перед боевым запуском');
      expect(doc.updatedBy).toBe('boss');
    });
  });

  test('logout чистит сессию', async () => {
    const response = await authed('/logout', { redirect: 'manual' });
    expect(response.status).toBe(302);
    const after = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
    expect(after.headers.get('location')).toBe('/login');
  });
});
