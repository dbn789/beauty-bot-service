const keyboards = require('../helpers/keyboards');
const { PRESETS_CATALOG, PRESET_CATEGORY } = require('@beauty/shared');

describe('keyboards (FR-B-030)', () => {
  test('показываются только категории, в которых есть пресеты', () => {
    const categories = keyboards.activeCategories();
    expect(categories).toContain(PRESET_CATEGORY.WOMEN);
    expect(categories).toContain(PRESET_CATEGORY.MEN);
    expect(categories).toContain(PRESET_CATEGORY.COLOR);
    expect(categories).not.toContain(PRESET_CATEGORY.LENGTH); // в каталоге v1 пусто
  });

  test('клавиатура категорий содержит выход к свободному тексту и отмену', () => {
    const kb = keyboards.buildCategoriesKeyboard();
    const flat = kb.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(flat).toContain('menu:free_text');
    expect(flat).toContain('act:cancel');
  });

  test('клавиатура пресетов категории строится из каталога', () => {
    const kb = keyboards.buildPresetsKeyboard(PRESET_CATEGORY.WOMEN);
    const flat = kb.reply_markup.inline_keyboard.flat();
    const womenCodes = PRESETS_CATALOG
      .filter((p) => p.category === PRESET_CATEGORY.WOMEN)
      .map((p) => `preset:${p.code}`);
    for (const code of womenCodes) {
      expect(flat.some((b) => b.callback_data === code)).toBe(true);
    }
    expect(flat.some((b) => b.callback_data === 'choice:back')).toBe(true);
  });

  test('кнопки действий после результата (FR-B-070)', () => {
    const kb = keyboards.buildResultActionsKeyboard();
    const flat = kb.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(flat).toEqual(['more:last', 'style:again']);
  });
});
