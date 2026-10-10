// express-приложение Internal API бота (ТЗ 9.1): health + (с Э4) маршруты для админки.
const express = require('express');
const { version } = require('../package.json');

const createApp = ({ logger, dbState = () => 'unknown', provider = null } = {}) => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    const db = dbState();
    // 503 при деградации: пробы платформы (Amvera) перезапустят контейнер,
    // а не будут считать «живой» болванку без БД (ревью 3e35882, риск 7)
    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degraded',
      app: 'beauty-bot',
      version,
      db,
      provider,
      ts: new Date().toISOString(),
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message }, 'internal api error');
    res.status(500).json({ error: 'internal' });
  });

  return app;
};

module.exports = {
  createApp,
};
