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

const loadConfig = (env = process.env) => {
  const isProduction = env.NODE_ENV === 'production';

  // В production нельзя молча уйти в mock (цветные квадраты клиентам) или в bfl без ключа
  if (isProduction && !env.GENERATION_PROVIDER) {
    throw new Error('GENERATION_PROVIDER must be set explicitly in production (bfl | fal | mock)');
  }
  if (isProduction && env.GENERATION_PROVIDER === 'bfl' && !env.BFL_API_KEY) {
    throw new Error('BFL_API_KEY is required when GENERATION_PROVIDER=bfl in production');
  }
  if (isProduction && env.GENERATION_PROVIDER === 'fal' && !env.FAL_API_KEY) {
    throw new Error('FAL_API_KEY is required when GENERATION_PROVIDER=fal in production');
  }

  return {
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
    maxQueueSize: int(env.MAX_QUEUE_SIZE, 50),
  };
};

module.exports = {
  loadConfig,
};
