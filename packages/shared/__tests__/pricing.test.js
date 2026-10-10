const { estimateCostUsd, PRICE_TABLE } = require('@beauty/shared/src/pricing');

describe('estimateCostUsd', () => {
  test('считает стоимость по цене модели × количество вариантов', () => {
    const price = PRICE_TABLE.bfl['flux.2-pro'];
    expect(estimateCostUsd('bfl', 'flux.2-pro', 3)).toBeCloseTo(price * 3, 6);
  });

  test('mock-провайдер бесплатный', () => {
    expect(estimateCostUsd('mock', 'anything', 5)).toBe(0);
  });

  test('неизвестный провайдер или модель возвращает null', () => {
    expect(estimateCostUsd('unknown', 'model', 1)).toBeNull();
    expect(estimateCostUsd('bfl', 'unknown-model', 1)).toBeNull();
  });
});
