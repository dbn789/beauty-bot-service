// Статусы запроса генерации (ТЗ 8.2)
const REQUEST_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DONE: 'done',
  ERROR: 'error',
  BUDGET_STOPPED: 'budget_stopped',
});

// Источник запроса: пресет из каталога или свободный текст
const REQUEST_SOURCE = Object.freeze({
  PRESET: 'preset',
  FREE_TEXT: 'free_text',
});

// Шаги диалога клиента (ТЗ 8.1, users.dialogState)
const DIALOG_STEP = Object.freeze({
  IDLE: 'idle',
  AWAIT_PHOTO: 'await_photo',
  AWAIT_CHOICE: 'await_choice',
  AWAIT_TEXT: 'await_text',
  PROCESSING: 'processing',
});

// Категории каталога причёсок
const PRESET_CATEGORY = Object.freeze({
  WOMEN: 'women',
  MEN: 'men',
  COLOR: 'color',
  LENGTH: 'length',
});

const PRESET_CATEGORIES = Object.values(PRESET_CATEGORY);

// Коды ошибок генерации (ТЗ FR-G-110, S3)
const ERROR_CODE = Object.freeze({
  VALIDATION: 'validation',
  PROVIDER_TIMEOUT: 'provider_timeout',
  PROVIDER_ERROR: 'provider_error',
  BUDGET_EXCEEDED: 'budget_exceeded',
  LIMIT_EXCEEDED: 'limit_exceeded',
  INTERNAL: 'internal',
});

const DEFAULTS = Object.freeze({
  VARIANTS: 3,
  DAILY_LIMIT: 3,
  DAILY_BUDGET_USD: 5,
  GENERATION_TIMEOUT_MS: 120000,
  GENERATION_CONCURRENCY: 2,
  RETENTION_DAYS: 30,
});

module.exports = {
  REQUEST_STATUS,
  REQUEST_SOURCE,
  DIALOG_STEP,
  PRESET_CATEGORY,
  PRESET_CATEGORIES,
  ERROR_CODE,
  DEFAULTS,
};
