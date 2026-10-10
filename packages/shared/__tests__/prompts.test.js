const { buildHairstylePrompt, HAIRSTYLE_PROMPT_TEMPLATE } = require('@beauty/shared/src/prompts');

describe('buildHairstylePrompt', () => {
  test('подставляет пожелание в шаблон', () => {
    const result = buildHairstylePrompt({ request: 'a sleek classic bob haircut' });
    expect(result).toBe(
      HAIRSTYLE_PROMPT_TEMPLATE.replace('{request}', 'a sleek classic bob haircut')
    );
  });

  test('тримит пробелы вокруг пожелания', () => {
    const result = buildHairstylePrompt({ request: '  short pixie  ' });
    expect(result).toContain('short pixie');
    expect(result).not.toContain('  short');
  });

  test('бросает ошибку на пустом пожелании', () => {
    expect(() => buildHairstylePrompt({ request: '' })).toThrow('request is required');
    expect(() => buildHairstylePrompt({ request: '   ' })).toThrow('request is required');
    expect(() => buildHairstylePrompt({})).toThrow('request is required');
  });

  test('шаблон требует сохранения лица и фона (FR-G-030)', () => {
    const result = buildHairstylePrompt({ request: 'balayage blonde' });
    expect(result).toContain('exactly the same as the reference photo');
    expect(result).toContain('Keep the face');
  });
});
