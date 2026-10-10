// Конфигурация контейнера из env с дефолтами из ТЗ (DEFAULTS в @beauty/shared).
const { DEFAULTS } = require('@beauty/shared');

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const float = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const loadConfig = (env = process.env) => ({
  env: env.NODE_ENV || 'development',
  logLevel: env.LOG_LEVEL || 'info',
  botToken: env.BOT_TOKEN || '',
  mongoUri: env.MONGO_URI || '',
  internalApiPort: int(env.INTERNAL_API_PORT, 8080),
  dataDir: env.DATA_DIR || './data-local',

  generationProvider: env.GENERATION_PROVIDER || 'mock',
  bflApiKey: env.BFL_API_KEY || '',
  falApiKey: env.FAL_API_KEY || '',
  bflModel: env.BFL_MODEL || 'flux.2-flex',

  variants: Math.min(int(env.VARIANTS_DEFAULT, DEFAULTS.VARIANTS), 3),
  dailyLimit: int(env.DAILY_LIMIT, DEFAULTS.DAILY_LIMIT),
  dailyBudgetUsd: float(env.DAILY_BUDGET_USD, DEFAULTS.DAILY_BUDGET_USD),
  generationTimeoutMs: int(env.GENERATION_TIMEOUT_MS, DEFAULTS.GENERATION_TIMEOUT_MS),
  generationConcurrency: int(env.GENERATION_CONCURRENCY, DEFAULTS.GENERATION_CONCURRENCY),
  retentionDays: int(env.RETENTION_DAYS, DEFAULTS.RETENTION_DAYS),
  mockDelayMs: int(env.MOCK_DELAY_MS, 1500),
});

module.exports = {
  loadConfig,
};
