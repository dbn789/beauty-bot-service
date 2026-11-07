// Точка входа контейнера beauty-bot (ТЗ 7.3):
// Internal API + бот + генерация + ретеншн + graceful shutdown.
const { User, GenerationRequest, Setting } = require('@beauty/shared');

// Сети без IPv6-маршрута: DNS bfl по ротации отдаёт AAAA первым, а fetch Node 18
// без отката ловит CONNECT_TIMEOUT — отсюда прерывистые отказы провайдера.
// Принудительный IPv4-first + happy-eyeballs, где доступно.
require('dns').setDefaultResultOrder('ipv4first');
try {
  require('net').setDefaultAutoSelectFamily(true);
} catch (_e) { /* node < 18.18: метода нет, ipv4first уже достаточно */ }

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
const { createSettingsReader } = require('./src/settings/reader');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const bootstrap = async () => {
  const config = loadConfig();
  const logger = createLogger({ env: config.env });
  const models = { User, GenerationRequest, Setting };
  const settings = createSettingsReader({ models });
  const runtime = { botReady: false };

  // Ждём завершения генераций в работе и их отправки клиентам (до timeoutMs),
  // чтобы деплой не ронял готовые результаты (ревью 308372d, риск 2)
  const drainQueue = async (queue, bot, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    const pending = () => queue.busy || (bot && bot.activeTracking && bot.activeTracking.size > 0);
    while (pending() && Date.now() < deadline) {
      await delay(500);
    }
    return !pending();
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

  // ключ строго своего провайдера (ревью 2c82805, риск 7: fal не должен получить ключ bfl)
  const providerOptions = {
    bfl: { apiKey: config.bflApiKey, model: config.bflModel, bflBaseUrl: config.bflBaseUrl || undefined },
    fal: { apiKey: config.falApiKey },
    mock: { delayMs: config.mockDelayMs },
  }[config.generationProvider];
  const provider = getProvider(config.generationProvider, providerOptions);
  logger.info({ provider: provider.name, model: provider.model }, 'generation provider selected');

  const queue = new LimiterQueue({ concurrency: config.generationConcurrency });
  const generation = createGenerationService({
    models, storage, provider, config, logger, queue,
  });
  const retention = createRetention({ models, storage, config, logger });

  const app = createApp({
    logger,
    dbState,
    provider: provider.name,
    // /health честен про «бот не подключён» (ревью eebdcf8, риск 1: тихий живой труп)
    botReady: () => runtime.botReady || !config.botToken,
    config,
    models,
    storage,
    bflProvider: provider && provider.name === 'bfl' ? provider : null,
  });
  const server = app.listen(config.internalApiPort, () => {
    logger.info({ port: config.internalApiPort }, 'internal api started');
  });

  // S7-восстановление и ретеншн не зависят от Telegram — запускаем сразу,
  // не дожидаясь доступности API (ревью eebdcf8, риск 3)
  let affectedUserIds = [];
  if (dbConnected) {
    affectedUserIds = await generation.recoverInterrupted();
    retention.start(); // FR-I-080
  } else {
    logger.warn('db not connected: recovery/retention/bot disabled, internal api only');
  }

  let bot = null;
  let stopping = false;
  if (config.botToken && dbConnected) {
    // Pre-flight через undici-fetch с таймаутом: ждём доступности Telegram,
    // выходим только на неверный токен. getMe заполняет botInfo — launch()
    // не будет дёргать его повторно (ревью eebdcf8, риски 2 и 7)
    for (;;) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`, {
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
          bot = createBot({
            token: config.botToken, logger, config, models, storage, generation, retention, settings,
          });
          bot.botInfo = await response.json().then((body) => body.result);
          break;
        }
        if (response.status === 401 || response.status === 404) {
          logger.error({ status: response.status }, 'BOT_TOKEN is invalid: exiting');
          process.exit(1);
        }
        logger.warn({ status: response.status }, 'telegram getMe non-ok, retry in 15s');
      } catch (error) {
        logger.warn({ err: error.message }, 'telegram unreachable, retry in 15s');
      }
      await delay(15000);
    }

    try {
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Подобрать причёску' },
        { command: 'help', description: 'Справка' },
        { command: 'privacy', description: 'Правила обработки фото' },
        { command: 'delete_my_data', description: 'Удалить мои данные' },
        { command: 'cancel', description: 'Отменить подбор' },
      ]);
    } catch (error) {
      // меню команд — косметика; нестабильный маршрут к Telegram не должен валить бот
      logger.warn({ err: error.message }, 'setMyCommands failed (non-fatal)');
    }

    // launch() резолвится только при остановке; сетевые сбои старта — повторяем,
    // неверный токен/409 (второй polling-инстанс) — выходим, пусть платформа рестартует
    const startPolling = () => {
      bot.launch().then(() => {
        logger.info('polling stopped');
      }).catch(async (error) => {
        const message = String((error && error.message) || error);
        if (/401|404|409|Conflict/i.test(message)) {
          logger.error({ err: message }, 'bot launch failed fatally: exiting');
          process.exit(1);
        }
        logger.warn({ err: message }, 'bot launch failed, retry in 15s');
        await delay(15000);
        if (!stopping) startPolling();
      });
      runtime.botReady = true;
      logger.info('bot launched (polling)');
    };
    startPolling();

    // уведомления пострадавшим о прерванных рестартом генерациях (S7)
    for (const userId of affectedUserIds) {
      try {
        const user = await models.User.findById(userId);
        if (user) {
          await bot.telegram.sendMessage(user.tgId, texts.generationError + '\n\n/cancel — сбросить диалог');
        }
      } catch (error) {
        logger.warn({ userId, err: error.message }, 'recovery notify failed');
      }
    }
  } else if (!config.botToken) {
    runtime.botReady = true; // режим «только internal api» — деградацией не считается
    logger.warn('BOT_TOKEN is not set: bot not launched, internal api only');
  }

  const shutdown = (signal) => async () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutdown');
    retention.stop();
    if (bot) {
      try {
        bot.stop(signal);
      } catch (_e) { /* polling ещё не создан — останавливать нечего */ }
    }
    const drained = await drainQueue(queue, bot, 30000);
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
