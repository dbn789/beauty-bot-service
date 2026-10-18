// express-приложение beauty-admin (ТЗ 5.3): auth-wall, страницы, прокси файлов.
// Фабрика — для интеграционных тестов; запуск (mongo/listen) — в index.js.
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { PRESETS_CATALOG, moscowDayKey, SETTINGS_SECTIONS } = require('@beauty/shared');
const { version } = require('../package.json');

const SESSION_COOKIE = 'beauty_session';
const SESSION_TTL_MS = 12 * 3600 * 1000; // FR-A-020: 12 часов

// Каркас настроек (заказ: таб «Настройки» с подтабами). Содержимое разделов
// наполняется поэтапно; пока в каждом — план и рабочая заметка администратора.
const SETTINGS_META = {
  users: {
    title: 'Пользователи',
    hint: 'Администраторы, клиенты и их лимиты',
    planned: [
      'Учётные записи администраторов: создание и смена пароля',
      'Индивидуальные лимиты генераций клиенту',
      'Блокировка клиентов',
    ],
  },
  bot: {
    title: 'Бот',
    hint: 'Тексты и поведение бота',
    planned: [
      'Приветствие и тексты сообщений',
      'Текст правил обработки фото (/privacy)',
      'Каталог пресетов: включение/выключение, порядок, названия',
    ],
  },
  generation: {
    title: 'Генерация',
    hint: 'Провайдер и ограничения',
    planned: [
      'Модель FLUX.2 и число вариантов',
      'Дневной лимит генераций на пользователя',
      'Дневной бюджет $ и таймаут',
      'Срок хранения фото (ретеншн)',
    ],
  },
  stand: {
    title: 'Стенд',
    hint: 'Инфраструктура и статус сервисов',
    planned: [
      'Статус сервисов и версии (бот/админка/БД)',
      'Регион и внутренние адреса (только чтение)',
      'Обзор переменных окружения без секретов (только чтение)',
    ],
  },
  deploy: {
    title: 'Деплой',
    hint: 'Пересборка и перезапуск сервисов на Amvera',
    planned: [
      'Кнопка «Задеплоить на Amvera» — уже работает (см. ниже)',
      'История запусков: кто и когда деплоил',
      'Статус сборки на платформе',
    ],
  },
};

const createAdminApp = ({ session, bot, models, config, logger, deployer = null, startedAt = Date.now() } = {}) => {
  const { AdminUser, BotUser, GenerationRequest, Setting } = models;
  const isProduction = config.env === 'production';

  const app = express();
  app.set('view engine', 'pug');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  app.locals.queryString = (obj) =>
    new URLSearchParams(Object.entries(obj).filter(([_k, v]) => v != null && v !== '')).toString();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false }));

  // ── открытые маршруты ──────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    const db = config.dbState();
    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degraded', app: 'beauty-admin', version, db,
      ts: new Date().toISOString(),
    });
  });

  app.get('/login', (_req, res) => res.render('login', { title: 'Вход', error: null }));

  app.post('/login', async (req, res) => {
    const { login, password } = req.body;
    try {
      const admin = await AdminUser.findOne({ login: String(login || '') });
      if (!admin || !(await bcrypt.compare(String(password || ''), admin.passwordHash))) {
        return res.status(401).render('login', { title: 'Вход', error: 'Неверный логин или пароль' });
      }
      await AdminUser.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
      res.setHeader('Set-Cookie',
        `${SESSION_COOKIE}=${session.sign(admin.login, SESSION_TTL_MS)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${isProduction ? '; Secure' : ''}`);
      return res.redirect('/dashboard');
    } catch (error) {
      logger.error({ err: error.message }, 'login failed');
      return res.status(500).render('login', { title: 'Вход', error: 'Ошибка сервера, попробуйте ещё раз' });
    }
  });

  // все остальные страницы — только после входа (FR-A-010)
  app.use((req, res, next) => {
    const cookieHeader = req.headers.cookie || '';
    const cookie = cookieHeader.split('; ').find((c) => c.startsWith(`${SESSION_COOKIE}=`)) || '';
    const login = session.verify(cookie.slice(SESSION_COOKIE.length + 1));
    if (!login) return res.redirect('/login');
    res.locals.adminLogin = login;
    return next();
  });

  app.get('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.redirect('/login');
  });

  app.get('/', (_req, res) => res.redirect('/dashboard'));

  // ── дашборд (FR-A-030) ────────────────────────────────────────────────────
  app.get('/dashboard', async (req, res) => {
    const days = [7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    let stats = null;
    let botError = null;
    try {
      stats = await bot.stats(days);
    } catch (error) {
      botError = error.message;
    }
    res.render('dashboard', { title: 'Дашборд', days, stats, botError });
  });

  // ── журнал генераций (FR-A-040) ───────────────────────────────────────────
  app.get('/generations', async (req, res) => {
    const { status = '', from = '', to = '' } = req.query;
    const page = Math.max(Number(req.query.page) || 1, 1);
    let data = null;
    let botError = null;
    try {
      data = await bot.generations({ status, from, to, page, limit: 20 });
    } catch (error) {
      botError = error.message;
    }
    const presetTitles = Object.fromEntries(PRESETS_CATALOG.map((p) => [p.code, `${p.emoji} ${p.titleRu}`]));
    res.render('generations', { title: 'Генерации', data, botError, presetTitles, filters: { status, from, to }, page });
  });

  // ── пользователи (FR-A-050) — чтение из общей БД напрямую ────────────────
  app.get('/users', async (_req, res) => {
    const fromDay = moscowDayKey(new Date(Date.now() - 30 * 24 * 3600 * 1000));
    const [users, recent] = await Promise.all([
      BotUser.find().sort({ createdAt: -1 }).limit(200).lean(),
      GenerationRequest.aggregate([
        { $match: { day: { $gte: fromDay } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ]),
    ]);
    const recentMap = new Map(recent.map((row) => [String(row._id), row.count]));
    res.render('users', { title: 'Пользователи', users, recentMap });
  });

  // ── настройки (каркас: подтабы + заметка; содержимое — поэтапно) ─────────
  app.get('/settings', (_req, res) => res.redirect('/settings/bot'));

  // запуск деплоя из админки (раздел «Деплой»): до POST /settings/:section,
  // чтобы маршрут не был съеден обобщённым
  app.post('/settings/deploy/run', async (req, res, next) => {
    if (!deployer) return next();
    const result = await deployer.deploy({ by: res.locals.adminLogin });
    const outcome = result.alreadyRunning ? 'busy' : (result.ok ? 'ok' : 'error');
    return res.redirect(`/settings/deploy?result=${outcome}`);
  });

  app.get('/settings/:section', async (req, res, next) => {
    if (!SETTINGS_SECTIONS.includes(req.params.section)) return next();
    const doc = await Setting.findOne({ section: req.params.section }).lean();
    res.render('settings', {
      title: `Настройки · ${SETTINGS_META[req.params.section].title}`,
      sections: SETTINGS_SECTIONS.map((key) => ({ key, title: SETTINGS_META[key].title })),
      section: req.params.section,
      current: SETTINGS_META[req.params.section],
      notes: (doc && doc.data && doc.data.notes) || '',
      saved: req.query.saved === '1',
      deploy: req.params.section === 'deploy' ? {
        configured: Boolean(deployer),
        running: deployer && deployer.running,
        lastResult: deployer && deployer.lastResult,
        flash: req.query.result || null,
      } : null,
    });
  });

  app.post('/settings/:section', async (req, res, next) => {
    if (!SETTINGS_SECTIONS.includes(req.params.section)) return next();
    const notes = String(req.body.notes || '').slice(0, 2000);
    await Setting.updateOne(
      { section: req.params.section },
      { $set: { data: { notes }, updatedBy: res.locals.adminLogin } },
      { upsert: true }
    );
    res.redirect(`/settings/${req.params.section}?saved=1`);
  });

  // ── о сервисе (FR-A-070) ──────────────────────────────────────────────────
  app.get('/about', async (_req, res) => {
    let meta = null;
    let botError = null;
    try {
      meta = (await bot.stats(1)).meta;
    } catch (error) {
      botError = error.message;
    }
    res.render('about', {
      title: 'О сервисе', meta, botError,
      admin: { version, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) },
    });
  });

  // ── прокси файлов бота (FR-A-060) ─────────────────────────────────────────
  app.get('/preview/:id', async (req, res) => {
    try {
      const upstream = await bot.file(req.params.id, String(req.query.ref || 'kind=source'));
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(buffer);
    } catch (_error) {
      return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'img', 'placeholder.svg'));
    }
  });

  app.use((req, res) => res.status(404).render('error', { title: 'Не найдено', message: `Страница ${req.path} не найдена` }));
  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message }, 'admin error');
    res.status(500).render('error', { title: 'Ошибка', message: 'Внутренняя ошибка сервера' });
  });

  return app;
};

module.exports = {
  createAdminApp,
  SESSION_COOKIE,
};
