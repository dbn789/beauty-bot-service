const { PRESETS_CATALOG } = require('@beauty/shared/src/presets-catalog');
const { PRESET_CATEGORIES } = require('@beauty/shared/src/constants');

describe('PRESETS_CATALOG', () => {
  test('в каталоге не меньше 12 пресетов (ТЗ, Приложение D)', () => {
    expect(PRESETS_CATALOG.length).toBeGreaterThanOrEqual(12);
  });

  test('коды пресетов уникальны', () => {
    const codes = PRESETS_CATALOG.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('все пресеты имеют корректную категорию, название и промпт', () => {
    for (const preset of PRESETS_CATALOG) {
      expect(PRESET_CATEGORIES).toContain(preset.category);
      expect(preset.titleRu.trim().length).toBeGreaterThan(0);
      expect(preset.promptEn.trim().length).toBeGreaterThan(0);
    }
  });

  test('промпты не меняют черты лица (только причёска/цвет)', () => {
    const forbiddenWords = ['face', 'nose', 'eyes', 'lips'];
    // «skin fade» — легитимный барберный термин, изменение кожи запрещаем
    const skinExceptFade = /\bskin\b(?!\s+fade)/i;
    for (const preset of PRESETS_CATALOG) {
      for (const word of forbiddenWords) {
        expect(preset.promptEn.toLowerCase()).not.toContain(word);
      }
      expect(skinExceptFade.test(preset.promptEn)).toBe(false);
    }
  });
});
