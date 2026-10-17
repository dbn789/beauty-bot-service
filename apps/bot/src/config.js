// Конфигурация контейнера из env с дефолтами из ТЗ (DEFAULTS в @beauty/shared).
const { DEFAULTS, PRICE_TABLE } = require('@beauty/shared');

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
    // flux-2-pro — рекомендованный BFL дефолт для редактирования ($0.045/вариант),
    // flux-2-klein-9b — бюджетный ($0.015), flux-2-flex/max — по задаче сравнения
    bflModel: (() => {
      const model = env.BFL_MODEL || 'flux-2-pro';
      // опечатка в модели молча выключала бы бюджет-стоп (estimateCostUsd → null → 0)
      if (env.GENERATION_PROVIDER === 'bfl' && !PRICE_TABLE.bfl[model]) {
        throw new Error(`BFL_MODEL "${model}" is unknown; valid: ${Object.keys(PRICE_TABLE.bfl).join(', ')}`);
      }
      return model;
    })(),
    // глобальный api.bfl.ai из некоторых сетей не отвечает (DPI/Azure Front Door):
    // тогда используем региональный, например https://api.eu.bfl.ai/v1
    bflBaseUrl: env.BFL_BASE_URL || '',

    variants: Math.min(int(env.VARIANTS_DEFAULT, DEFAULTS.VARIANTS), 3),
    dailyLimit: int(env.DAILY_LIMIT, DEFAULTS.DAILY_LIMIT),
    dailyBudgetUsd: float(env.DAILY_BUDGET_USD, DEFAULTS.DAILY_BUDGET_USD),
    generationTimeoutMs: int(env.GENERATION_TIMEOUT_MS, DEFAULTS.GENERATION_TIMEOUT_MS),
    generationConcurrency: int(env.GENERATION_CONCURRENCY, DEFAULTS.GENERATION_CONCURRENCY),
    retentionDays: int(env.RETENTION_DAYS, DEFAULTS.RETENTION_DAYS),
    mockDelayMs: int(env.MOCK_DELAY_MS, 1500),
    maxQueueSize: int(env.MAX_QUEUE_SIZE, 50),
    // защита маршрутов /api и /files (Internal API для админки, ТЗ FR-I-030);
    // пусто → маршруты закрыты (fail-closed)
    internalApiKey: env.INTERNAL_API_KEY || '',
  };
};

module.exports = {
  loadConfig,
};
