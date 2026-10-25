// Юнит-тесты чистой логики доступа.
const { checkAccess, resolveAccess, ACCESS_MODES } = require('../helpers/access');

const entries = [{ tgId: 111 }, { tgId: 222 }];

describe('checkAccess (белый/чёрный список)', () => {
  test('off: доступ всем', () => {
    expect(checkAccess('off', entries, 999)).toBe(true);
    expect(checkAccess('off', [], 999)).toBe(true);
    expect(checkAccess(undefined, entries, 999)).toBe(true);
  });

  test('whitelist: только записи списка', () => {
    expect(checkAccess('whitelist', entries, 111)).toBe(true);
    expect(checkAccess('whitelist', entries, 999)).toBe(false);
    expect(checkAccess('whitelist', [], 111)).toBe(false); // пустой белый список = закрыто всем
  });

  test('blacklist: все, кроме записей списка', () => {
    expect(checkAccess('blacklist', entries, 111)).toBe(false);
    expect(checkAccess('blacklist', entries, 999)).toBe(true);
    expect(checkAccess('blacklist', [], 111)).toBe(true);
  });

  test('режимы согласованы с админкой', () => {
    expect(ACCESS_MODES).toEqual(['off', 'whitelist', 'blacklist']);
  });

  test('resolveAccess берёт список активного режима и не трогает второй', () => {
    const data = {
      accessMode: 'whitelist',
      lists: { whitelist: [{ tgId: 1 }], blacklist: [{ tgId: 2 }] },
    };
    expect(resolveAccess(data)).toEqual({ mode: 'whitelist', entries: [{ tgId: 1 }] });
    expect(resolveAccess({ accessMode: 'nope' }).mode).toBe('off');
    expect(resolveAccess(null).entries).toEqual([]);
  });
});
