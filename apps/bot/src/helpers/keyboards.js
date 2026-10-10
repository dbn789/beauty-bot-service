// Клавиатуры бота (ТЗ FR-B-030/070): согласие, меню, категории/пресеты, действия.
const { PRESETS_CATALOG, PRESET_CATEGORY } = require('@beauty/shared');

const CATEGORY_TITLES = {
  [PRESET_CATEGORY.WOMEN]: '👩 Женские',
  [PRESET_CATEGORY.MEN]: '👨 Мужские',
  [PRESET_CATEGORY.COLOR]: '🎨 Окрашивание',
  [PRESET_CATEGORY.LENGTH]: '📏 Длина',
};

const activeCategories = () => {
  const present = new Set(PRESETS_CATALOG.map((p) => p.category));
  return Object.values(PRESET_CATEGORY).filter((c) => present.has(c));
};

const presetsByCategory = (category) =>
  PRESETS_CATALOG
    .filter((p) => p.category === category)
    .sort((a, b) => a.sortOrder - b.sortOrder);

const buildPrivacyKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Принимаю и продолжаю', callback_data: 'privacy:accept' }],
    ],
  },
});

const buildMainMenuKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: '💇‍♀️ Подобрать причёску', callback_data: 'menu:start' }],
    ],
  },
});

const buildCategoriesKeyboard = () => {
  const categories = activeCategories();
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(
      categories.slice(i, i + 2).map((c) => ({
        text: CATEGORY_TITLES[c],
        callback_data: `cat:${c}`,
      }))
    );
  }
  rows.push([{ text: '✍️ Своё пожелание', callback_data: 'menu:free_text' }]);
  rows.push([{ text: '❌ Отменить', callback_data: 'act:cancel' }]);
  return { reply_markup: { inline_keyboard: rows } };
};

const buildPresetsKeyboard = (category) => {
  const presets = presetsByCategory(category);
  const rows = [];
  for (let i = 0; i < presets.length; i += 2) {
    rows.push(
      presets.slice(i, i + 2).map((p) => ({
        text: `${p.emoji} ${p.titleRu}`,
        callback_data: `preset:${p.code}`,
      }))
    );
  }
  rows.push([{ text: '⬅️ Назад к категориям', callback_data: 'choice:back' }]);
  return { reply_markup: { inline_keyboard: rows } };
};

const buildResultActionsKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔁 Ещё варианты', callback_data: 'more:last' },
        { text: '💇 Другой стиль', callback_data: 'style:again' },
      ],
    ],
  },
});

const buildRetryKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [[{ text: '🔁 Повторить', callback_data: 'act:retry' }]],
  },
});

module.exports = {
  CATEGORY_TITLES,
  activeCategories,
  presetsByCategory,
  buildPrivacyKeyboard,
  buildMainMenuKeyboard,
  buildCategoriesKeyboard,
  buildPresetsKeyboard,
  buildResultActionsKeyboard,
  buildRetryKeyboard,
};
