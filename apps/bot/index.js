// Точка входа контейнера beauty-bot (ТЗ 7.3):
// Internal API + бот + генерация + ретеншн + graceful shutdown.
const { User, GenerationRequest } = require('@beauty/shared');
const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { connectDb, dbState, disconnectDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createBot } = require('./src/bot');
const { createFileStorage } = require('./src/storage/files');
const { createRetention } = require('./src/storage/retention');
const { getProvider } = require('./src/generation/providers');
const { LimiterQueue } = require('./src/generation/queue');
const { createGenerationService } = require('./src/generation/service');

const config = loadConfig();
const logger = createLogger({ env: config.env });
const models = { User, GenerationRequest };

const bootstrap = async () => {
  const storage = createFileStorage({ dataDir: config.dataDir, logger });
  await storage.init();

  const dbConnected = Boolean(await connectDb({ mongoUri: config.mongoUri, logger }).catch(() => null));

  const provider = getProvider(config.generationProvider, { delayMs: config.mockDelayMs });
  logger.info({ provider: provider.name, model: provider.model }, 'generation provider selected');

  const queue = new LimiterQueue({ concurrency: config.generationConcurrency });
  const generation = createGenerationService({
    models, storage, provider, config, logger, queue,
  });
  const retention = createRetention({ models, storage, config, logger });

  if (dbConnected) {
    await generation.recoverInterrupted(); // S7
    retention.start(); // FR-I-080
  } else {
    logger.warn('db not connected: recovery/retention/bot disabled, internal api only');
  }

  const app = createApp({ logger, dbState, provider: provider.name });
  const server = app.listen(config.internalApiPort, () => {
    logger.info({ port: config.internalApiPort }, 'internal api started');
  });

  let bot = null;
  if (config.botToken && dbConnected) {
    bot = createBot({ token: config.botToken, logger, config, models, storage, generation, retention });
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Подобрать причёску' },
      { command: 'help', description: 'Справка' },
      { command: 'privacy', description: 'Правила обработки фото' },
      { command: 'delete_my_data', description: 'Удалить мои данные' },
      { command: 'cancel', description: 'Отменить подбор' },
    ]);
    bot.launch();
    logger.info('bot launched (polling)');
  } else if (!config.botToken) {
    logger.warn('BOT_TOKEN is not set: bot not launched, internal api only');
  }

  const shutdown = (signal) => async () => {
    logger.info({ signal }, 'shutdown');
    retention.stop();
    if (bot) bot.stop(signal);
    server.close(() => process.exit(0));
    try {
      await disconnectDb();
    } catch (_e) { /* уже закрыто */ }
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));
};

bootstrap().catch((error) => {
  logger.error({ err: error.message }, 'bootstrap failed');
  process.exit(1);
});
