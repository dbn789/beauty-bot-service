// Internal API бота (ТЗ 9.1): health (пробы платформы, без ключа) + маршруты
// для админки (x-api-key): статистика, журнал генераций, отдача файлов.
const express = require('express');
const { version } = require('../package.json');
const { REQUEST_STATUS, PRESETS_CATALOG, DEFAULTS } = require('@beauty/shared');
const { moscowDayKey } = require('./helpers/day');

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

const createApp = ({
  logger,
  dbState = () => 'unknown',
  provider = null,
  botReady = () => true,
  config = null,
  models = null,
  storage = null,
  meta = () => ({}),
} = {}) => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    const db = dbState();
    const telegramOk = botReady();
    const ok = db === 'ok' && telegramOk;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      app: 'beauty-bot',
      version,
      db,
      telegram: telegramOk ? 'ok' : 'waiting',
      provider,
      ts: new Date().toISOString(),
    });
  });

  // ── защита маршрутов для админки (FR-I-030) ────────────────────────────────
  const internalApiKey = config ? config.internalApiKey : '';
  const requireInternalKey = (_req, res, next) => {
    if (!internalApiKey) {
      // ключ не задан → маршруты закрыты (fail-closed), а не открыты всем
      return res.status(503).json({ error: 'internal api key not configured' });
    }
    const header = _req.header('x-api-key');
    if (!header || header !== internalApiKey) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };

  const dayKeyOrNone = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null);

  // Агрегаты для дашборда (объёмы салона малые — считаем в JS честно и просто)
  app.get('/api/stats', requireInternalKey, async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
      const today = moscowDayKey();
      const fromDay = moscowDayKey(new Date(Date.now() - (days - 1) * 24 * 3600 * 1000));

      const requests = await models.GenerationRequest.find(
        { day: { $gte: fromDay, $lte: today } },
        { day: 1, status: 1, userId: 1, presetCode: 1, source: 1, variants: 1 }
      ).lean();

      const byDay = {};
      const users = new Set();
      let total = 0;
      let done = 0;
      let errors = 0;
      let spent = 0;
      const presetCounts = {};
      let spentToday = 0;

      for (const request of requests) {
        const row = byDay[request.day] || (byDay[request.day] = {
          day: request.day, total: 0, done: 0, error: 0, users: new Set(), spent: 0,
        });
        row.total += 1;
        total += 1;
        if (request.userId) { row.users.add(String(request.userId)); users.add(String(request.userId)); }
        if (request.status === REQUEST_STATUS.DONE) {
          row.done += 1;
          done += 1;
          for (const variant of request.variants || []) {
            row.spent += variant.costUsd || 0;
            spent += variant.costUsd || 0;
            if (request.day === today) spentToday += variant.costUsd || 0;
          }
        }
        if (request.status === REQUEST_STATUS.ERROR) { row.error += 1; errors += 1; }
        if (request.presetCode) presetCounts[request.presetCode] = (presetCounts[request.presetCode] || 0) + 1;
      }

      const topPresets = Object.entries(presetCounts)
        .map(([code, count]) => {
          const preset = PRESETS_CATALOG.find((p) => p.code === code);
          return { code, count, title: preset ? `${preset.emoji} ${preset.titleRu}` : code };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      res.json({
        period: { days, fromDay, today },
        totals: {
          requests: total,
          done,
          errors,
          errorRate: total ? Math.round((errors / total) * 100) : 0,
          users: users.size,
          spentUsd: Math.round(spent * 1000) / 1000,
        },
        budgetToday: {
          spentUsd: Math.round(spentToday * 1000) / 1000,
          limitUsd: config ? config.dailyBudgetUsd : DEFAULTS.DAILY_BUDGET_USD,
        },
        byDay: Object.values(byDay)
          .sort((a, b) => (a.day < b.day ? -1 : 1))
          .map((row) => ({ ...row, users: row.users.size, spent: Math.round(row.spent * 1000) / 1000 })),
        topPresets,
        meta: {
          app: 'beauty-bot',
          version,
          provider,
          model: config ? config.bflModel : null,
          variants: config ? config.variants : DEFAULTS.VARIANTS,
          dailyLimit: config ? config.dailyLimit : DEFAULTS.DAILY_LIMIT,
          retentionDays: config ? config.retentionDays : DEFAULTS.RETENTION_DAYS,
          uptimeSec: Math.floor(process.uptime()),
          ...meta(),
        },
      });
    } catch (error) {
      logger.error({ err: error.message }, 'stats failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Журнал генераций: фильтры статуса и дат (дни МСК), пагинация
  app.get('/api/generations', requireInternalKey, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const query = {};
      const status = req.query.status ? String(req.query.status) : null;
      if (status && Object.values(REQUEST_STATUS).includes(status)) query.status = status;
      const from = dayKeyOrNone(req.query.from);
      const to = dayKeyOrNone(req.query.to);
      if (from || to) {
        query.day = {};
        if (from) query.day.$gte = from;
        if (to) query.day.$lte = to;
      }

      const [total, items] = await Promise.all([
        models.GenerationRequest.countDocuments(query),
        models.GenerationRequest.find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);

      const userIds = [...new Set(items.map((i) => String(i.userId)))];
      const users = userIds.length
        ? await models.User.find({ _id: { $in: userIds } }, { tgId: 1, firstName: 1, username: 1 }).lean()
        : [];
      const userMap = new Map(users.map((u) => [String(u._id), u]));

      res.json({
        total,
        page,
        limit,
        pages: Math.max(Math.ceil(total / limit), 1),
        items: items.map((item) => ({
          id: String(item._id),
          createdAt: item.createdAt,
          day: item.day,
          status: item.status,
          source: item.source,
          presetCode: item.presetCode,
          userText: item.userText,
          durationMs: item.durationMs,
          error: item.error,
          variantsCount: (item.variants || []).length,
          deletedAt: item.deletedAt,
          user: item.userId && userMap.get(String(item.userId))
            ? {
              tgId: userMap.get(String(item.userId)).tgId,
              firstName: userMap.get(String(item.userId)).firstName,
              username: userMap.get(String(item.userId)).username,
            }
            : null,
        })),
      });
    } catch (error) {
      logger.error({ err: error.message }, 'generations list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Файлы: исходник и варианты конкретного запроса (FR-A-060: только через бота)
  app.get('/files/:id', requireInternalKey, async (req, res) => {
    try {
      const request = await models.GenerationRequest.findById(req.params.id).lean();
      if (!request) return res.status(404).json({ error: 'not_found' });

      let path;
      if (req.query.kind === 'source') {
        path = request.sourcePhoto && request.sourcePhoto.storagePath;
      } else if (/^\d+$/.test(String(req.query.v || '')) && Number(req.query.v) >= 1) {
        const index = Number(req.query.v) - 1;
        path = request.variants && request.variants[index] && request.variants[index].storagePath;
      }
      if (!path) return res.status(400).json({ error: 'bad_file_ref' });

      const buffer = await storage.read(path);
      const ext = path.split('.').pop().toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(buffer);
    } catch (error) {
      // файл удалён ретеншном или путь битый
      logger.debug({ err: error.message, id: req.params.id }, 'file read failed');
      return res.status(404).json({ error: 'not_found' });
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message }, 'internal api error');
    res.status(500).json({ error: 'internal' });
  });

  return app;
};

module.exports = {
  createApp,
};
