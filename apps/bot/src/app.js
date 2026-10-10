// express-приложение Internal API бота (ТЗ 9.1): health + (с Э1) маршруты для админки.
const express = require('express');
const { version } = require('../package.json');

const createApp = ({ logger, dbState = () => 'unknown' } = {}) => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: 'beauty-bot',
      version,
      db: dbState(),
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
