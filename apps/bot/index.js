// Точка входа контейнера beauty-bot (ТЗ 7.3):
// Internal API + бот + генерация + ретеншн + graceful shutdown.
const { User, GenerationRequest } = require('@beauty/shared');

// Сети без IPv6-маршрута: DNS bfl по ротации отдаёт AAAA первым, а fetch Node 18
// без отката ловит CONNECT_TIMEOUT — отсюда прерывистые отказы провайдера.
// Принудительный IPv4-first + happy-eyeballs, где доступно.
require('dns').setDefaultResultOrder('ipv4first');
try {
  require('net').setDefaultAutoSelectFamily(true);
} catch (_e) { /* node < 18.13: флага нет, ipv4first уже достаточен */ }

const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { connectDb, dbState, disconnectDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createBot } = require('./src/bot');
const texts = require('./src/helpers/texts');
const { createFileStorage } = require('./src/storage/files');
const { createRetention } = require('./src/storage/retention');
const { getProvider } = require('./src/generation/providers');
const { LimiterQueue } = require('./src/generation/queue');
const { createGenerationService } = require('./src/generation/service');

const bootstrap = async () => {
  const config = loadConfig();
  const logger = createLogger({ env: config.env });
  const models = { User, GenerationRequest };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Ждём завершения генераций в работе (до timeoutMs), чтобы деплой не ронял
  // живые запросы (ревью 3e35882, риск 3)
  const drainQueue = async (queue, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (queue.busy && Date.now() < deadline) {
      await delay(500);
    }
    return !queue.busy;
  };
  const storage = createFileStorage({ dataDir: config.dataDir, logger });
  await storage.init();

  const connection = await connectDb({ mongoUri: config.mongoUri, logger });
  // в production БД обязательна: падаем громко, платформа перезапустит контейнер
  if (!connection && config.env === 'production') {
    logger.error('mongo unavailable in production: exiting (platform will restart)');
    process.exit(1);
  }
  const dbConnected = Boolean(connection);

  const provider = getProvider(config.generationProvider, {
    delayMs: config.mockDelayMs,
    apiKey: config.bflApiKey || config.falApiKey,
    model: config.bflModel,
    bflBaseUrl: config.bflBaseUrl || undefined,
  });
  logger.info({ provider: provider.name, model: provider.model }, 'generation provider selected');

  const queue = new LimiterQueue({ concurrency: config.generationConcurrency });
  const generation = createGenerationService({
    models, storage, provider, config, logger, queue,
  });
  const retention = createRetention({ models, storage, config, logger });

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
    bot.launch().catch((error) => {
      // неверный токен / 409 (второй polling-инстанс) — падаем явно, с причиной в логе
      logger.error({ err: error.message }, 'bot launch failed');
      process.exit(1);
    });
    logger.info('bot launched (polling)');
  } else if (!config.botToken) {
    logger.warn('BOT_TOKEN is not set: bot not launched, internal api only');
  }

  if (dbConnected) {
    // S7: восстановление + уведомление пострадавших клиентов (бот уже создан)
    const affectedUserIds = await generation.recoverInterrupted();
    for (const userId of affectedUserIds) {
      if (!bot) break;
      try {
        const user = await models.User.findById(userId);
        if (user) {
          await bot.telegram.sendMessage(user.tgId, texts.generationError + '\n\n/cancel — сбросить диалог');
        }
      } catch (error) {
        logger.warn({ userId, err: error.message }, 'recovery notify failed');
      }
    }
    retention.start(); // FR-I-080
  } else {
    logger.warn('db not connected: recovery/retention/bot disabled, internal api only');
  }

  const shutdown = (signal) => async () => {
    logger.info({ signal }, 'shutdown');
    retention.stop();
    if (bot) bot.stop(signal);
    const drained = await drainQueue(queue, 30000);
    logger.info({ drained }, 'queue drain finished');
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
  // сюда попадает и ошибка конфигурации (loadConfig) — с внятным текстом, без сырого стека
  console.error(JSON.stringify({
    level: 50, app: 'beauty-bot', msg: 'bootstrap failed', err: error.message,
  }));
  process.exit(1);
});
