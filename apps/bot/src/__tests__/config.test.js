const { loadConfig } = require('../config');

describe('loadConfig: валидация (ревью 2c82805, риск 3)', () => {
  test('опечатка в BFL_MODEL валит старт с перечнем допустимых моделей', () => {
    expect(() => loadConfig({
      GENERATION_PROVIDER: 'bfl',
      BFL_MODEL: 'flux.2-flex', // старый формат с точкой
    })).toThrow(/unknown.*flux-2-pro/);
  });

  test('валидная модель bfl проходит', () => {
    const config = loadConfig({ GENERATION_PROVIDER: 'bfl', BFL_MODEL: 'flux-2-pro' });
    expect(config.bflModel).toBe('flux-2-pro');
  });

  test('валидация модели не мешает другим провайдерам', () => {
    expect(() => loadConfig({ GENERATION_PROVIDER: 'mock', BFL_MODEL: 'typo' })).not.toThrow();
  });

  test('production без явного GENERATION_PROVIDER не стартует (риск 8 из Э1)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/GENERATION_PROVIDER/);
  });

  test('production c bfl без ключа не стартует', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production', GENERATION_PROVIDER: 'bfl',
    })).toThrow(/BFL_API_KEY/);
  });
});
