// Тарифная таблица провайдеров для бюджет-стопа (ТЗ FR-G-080, Приложение B).
// Цены — за 1 вариант редактирования с референсом (USD), по docs.bfl.ai
// (quick_start/pricing, «from» за мегапиксель базового разрешения) на 2026-10.
// Влияют только на срабатывание дневного бюджета, не на биллинг провайдера;
// сверяются с фактическим расходом кредитов после живых прогонов Э2.

const PRICE_TABLE = Object.freeze({
  bfl: {
    'flux-2-pro': 0.045,       // редактирование, рекомендованный дефолт
    'flux-2-flex': 0.06,
    'flux-2-max': 0.07,
    'flux-2-klein-9b': 0.015,  // бюджетный вариант для сравнения
    'flux-2-klein-4b': 0.014,
  },
  fal: {
    // оценки до интеграции (если bfl не устроит качеством) — уточнить при подключении
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
