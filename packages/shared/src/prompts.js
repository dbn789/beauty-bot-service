// Промпт-билдер FLUX.2 для подбора причёсок (ТЗ FR-G-030).
// Шаблон обязан требовать сохранения лица, черт, позы и фона референса.

const HAIRSTYLE_PROMPT_TEMPLATE =
  'Edit the person\'s hairstyle: {request}. ' +
  'Keep the face, facial features, skin tone, head pose and background ' +
  'exactly the same as the reference photo. Photorealistic, salon quality.';

/**
 * Собирает итоговый промпт из фрагмента пожелания (пресет или свободный текст).
 * @param {{ request: string }} params
 * @returns {string}
 */
const buildHairstylePrompt = ({ request }) => {
  const clean = String(request == null ? '' : request).trim();
  if (!clean) {
    throw new Error('buildHairstylePrompt: request is required');
  }
  return HAIRSTYLE_PROMPT_TEMPLATE.replace('{request}', clean);
};

module.exports = {
  HAIRSTYLE_PROMPT_TEMPLATE,
  buildHairstylePrompt,
};
