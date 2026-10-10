// Тарифная таблица провайдеров для бюджет-стопа (ТЗ FR-G-080, Приложение B).
// Цены — ОЦЕНКИ за 1 вариант (USD) по данным bfl.ai/fal.ai на 2026-10,
// уточняются на этапе Э2 при выборе модели; расхождение влияет только на
// срабатывание дневного бюджета, не на выставление счетов провайдером.

const PRICE_TABLE = Object.freeze({
  bfl: {
    'flux.2-pro': 0.06,
    'flux.2-flex': 0.03,
    'flux.2-dev': 0.03,
  },
  fal: {
    'flux-2-dev': 0.03,
    'flux-2-pro': 0.06,
  },
  mock: {
    '*': 0,
  },
});

/**
 * Оценка стоимости генерации в USD.
 * @param {string} provider - bfl | fal | mock
 * @param {string} model - ключ из PRICE_TABLE
 * @param {number} count - количество вариантов
 * @returns {number|null} null, если сочетание провайдер+модель неизвестно
 */
const estimateCostUsd = (provider, model, count) => {
  const providerTable = PRICE_TABLE[provider];
  if (!providerTable) return null;
  const price = providerTable[model] != null ? providerTable[model] : providerTable['*'];
  if (price == null) return null;
  return price * count;
};

module.exports = {
  PRICE_TABLE,
  estimateCostUsd,
};
