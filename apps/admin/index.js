// Точка входа контейнера beauty-admin: конфиг, mongo, bootstrap админа, listen.
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { AdminUser, User: BotUser, GenerationRequest, Setting } = require('@beauty/shared');
const { createSession } = require('./helpers/session');
const { createBotApiClient } = require('./helpers/botApiClient');
const { createAdminApp } = require('./src/app');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  adminLogin: process.env.ADMIN_LOGIN || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  botUrl: process.env.BOT_INTERNAL_API_URL || '',
  botKey: process.env.BOT_INTERNAL_API_KEY || '',
};

const bootLog = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, app: 'beauty-admin', env: config.env, msg, ...extra }));

const isProduction = config.env === 'production';
if (isProduction && !config.sessionSecret) {
  bootLog(50, 'SESSION_SECRET is required in production');
  process.exit(1);
}

const start = async () => {
  await mongoose.connect(config.mongoUri);

  // Первый администратор из env (если учёток нет) — managed-БД недоступна снаружи,
  // так что создание учётки — через переменные окружения Amvera
  if ((await AdminUser.countDocuments()) === 0) {
    if (config.adminLogin && config.adminPassword) {
      await AdminUser.create({
        login: config.adminLogin,
        passwordHash: await bcrypt.hash(config.adminPassword, 10),
      });
      bootLog(30, 'admin user bootstrapped from env', { login: config.adminLogin });
    } else {
      bootLog(30, 'no admin users and ADMIN_LOGIN/ADMIN_PASSWORD not set: вход невозможен до настройки');
    }
  }

  const app = createAdminApp({
    session: createSession(config.sessionSecret || 'development-secret-not-for-prod'),
    bot: createBotApiClient({ baseUrl: config.botUrl, apiKey: config.botKey }),
    models: { AdminUser, BotUser, GenerationRequest, Setting },
    config: { ...config, dbState: () => (mongoose.connection.readyState === 1 ? 'ok' : 'disconnected') },
    logger: { error: (extra, msg) => bootLog(50, msg, extra) },
  });

  const server = app.listen(config.port, () => bootLog(30, 'started', { port: config.port }));
  const shutdown = (signal) => () => {
    bootLog(30, 'shutdown', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));
};

start().catch((error) => {
  bootLog(50, 'startup failed', { err: error.message });
  process.exit(1);
});
