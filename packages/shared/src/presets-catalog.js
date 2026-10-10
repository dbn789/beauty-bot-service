// Стартовый каталог пресетов-причёсок (ТЗ, Приложение D; seed через scripts/seed-presets.js).
// promptEn — фрагмент для промпт-билдера, только про причёску/цвет, без черт лица.

const PRESETS_CATALOG = Object.freeze([
  { code: 'bob_classic', titleRu: 'Классическое каре', category: 'women', emoji: '💇‍♀️', sortOrder: 10, promptEn: 'a sleek classic bob haircut, chin length, smooth glossy finish' },
  { code: 'lob_waves', titleRu: 'Удлинённое каре с волнами', category: 'women', emoji: '🌊', sortOrder: 20, promptEn: 'a long bob with soft beach waves, collarbone length' },
  { code: 'curly_volume', titleRu: 'Объёмные кудри', category: 'women', emoji: '🌀', sortOrder: 30, promptEn: 'voluminous defined curls, shoulder length, bouncy texture' },
  { code: 'long_layers', titleRu: 'Длинные слоистые', category: 'women', emoji: '✨', sortOrder: 40, promptEn: 'a long layered haircut with soft waves and curtain bangs' },
  { code: 'pixie', titleRu: 'Пикси', category: 'women', emoji: '⚡', sortOrder: 50, promptEn: 'a short textured pixie cut with piecey bangs' },
  { code: 'high_ponytail', titleRu: 'Гладкий высокий хвост', category: 'women', emoji: '🎀', sortOrder: 60, promptEn: 'a sleek high ponytail look with polished roots' },
  { code: 'undercut', titleRu: 'Андеркат', category: 'men', emoji: '🪒', sortOrder: 70, promptEn: 'an undercut with textured top, sharp sides' },
  { code: 'skin_fade', titleRu: 'Фейд', category: 'men', emoji: '🧑‍🦱', sortOrder: 80, promptEn: 'a skin fade with short crop on top, clean lines' },
  { code: 'classic_side_part', titleRu: 'Классический пробор', category: 'men', emoji: '🎩', sortOrder: 90, promptEn: 'a classic side part haircut, tidy and neat' },
  { code: 'medium_textured', titleRu: 'Средняя длина, текстура', category: 'men', emoji: '🌬️', sortOrder: 100, promptEn: 'medium length textured hair with natural movement' },
  { code: 'blonde_balayage', titleRu: 'Блонд балаяж', category: 'color', emoji: '🌸', sortOrder: 110, promptEn: 'balayage blonde color with soft dimensional highlights' },
  { code: 'chocolate_brown', titleRu: 'Тёмный шоколад', category: 'color', emoji: '🍫', sortOrder: 120, promptEn: 'rich chocolate brown hair color, glossy deep tone' },
]);

module.exports = {
  PRESETS_CATALOG,
};
