// Точка входа контейнера beauty-bot (ТЗ 7.3): Internal API + бот + graceful shutdown.
const { createApp } = require('./src/app');
const { createBot } = require('./src/bot');
const { createLogger } = require('./src/logger');

const config = {
  env: process.env.NODE_ENV || 'development',
  botToken: process.env.BOT_TOKEN || '',
  internalApiPort: Number(process.env.INTERNAL_API_PORT || 8080),
};

const logger = createLogger({ env: config.env });

const bootstrap = async () => {
  const app = createApp({ logger });
  const server = app.listen(config.internalApiPort, () => {
    logger.info({ port: config.internalApiPort }, 'internal api started');
  });

  let bot = null;
  if (config.botToken) {
    bot = createBot({ token: config.botToken, logger });
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Подобрать причёску' },
      { command: 'help', description: 'Справка' },
      { command: 'privacy', description: 'Правила обработки фото' },
      { command: 'delete_my_data', description: 'Удалить мои данные' },
      { command: 'cancel', description: 'Отменить подбор' },
    ]);
    bot.launch();
    logger.info('bot launched (polling)');
  } else {
    logger.warn('BOT_TOKEN is not set: bot not launched, internal api only');
  }

  const shutdown = (signal) => async () => {
    logger.info({ signal }, 'shutdown');
    if (bot) bot.stop(signal);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));
};

bootstrap().catch((error) => {
  logger.error({ err: error.message }, 'bootstrap failed');
  process.exit(1);
});
