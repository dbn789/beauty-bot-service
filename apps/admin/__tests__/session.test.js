const { createSession } = require('../helpers/session');

describe('session (HMAC cookie)', () => {
  const session = createSession('test-secret-at-least-16-chars');

  test('sign → verify возвращает логин', () => {
    const token = session.sign('admin', 3600_000);
    expect(session.verify(token)).toBe('admin');
  });

  test('подделка подписи отклоняется', () => {
    const token = session.sign('admin', 3600_000);
    const tampered = `${token.slice(0, -4)}dead`;
    expect(session.verify(tampered)).toBeNull();
  });

  test('просроченный токен отклоняется', () => {
    const token = session.sign('admin', -1000);
    expect(session.verify(token)).toBeNull();
  });

  test('мусор отклоняется', () => {
    expect(session.verify('')).toBeNull();
    expect(session.verify('abc')).toBeNull();
    expect(session.verify('a.b.c.d')).toBeNull();
  });

  test('чужой секрет не принимает наш токен', () => {
    const other = createSession('another-secret-16-chars!!');
    expect(other.verify(session.sign('admin', 1000))).toBeNull();
  });

  test('секрет короче 16 символов запрещён', () => {
    expect(() => createSession('short')).toThrow(/SESSION_SECRET/);
  });
});
