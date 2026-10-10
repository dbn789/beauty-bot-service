const { moscowDayKey, msUntilMoscowMidnight, nextResetTimeMoscow } = require('../helpers/day');

describe('day (Europe/Moscow, без DST)', () => {
  test('дневной ключ в формате YYYY-MM-DD', () => {
    expect(moscowDayKey(new Date('2026-10-04T10:00:00Z'))).toBe('2026-10-04'); // 13:00 МСК
  });

  test('граница суток: 23:59:59 МСК — ещё сегодня, 00:00 МСК — уже завтра', () => {
    expect(moscowDayKey(new Date('2026-10-04T20:59:59Z'))).toBe('2026-10-04');
    expect(moscowDayKey(new Date('2026-10-04T21:00:00Z'))).toBe('2026-10-05');
  });

  test('до московской полуночи: 23:00 МСК → ровно час', () => {
    expect(msUntilMoscowMidnight(new Date('2026-10-04T20:00:00Z'))).toBe(3600000);
  });

  test('после полуночи МСК считается следующая полночь', () => {
    const now = new Date('2026-10-04T21:00:01Z'); // 00:00:01 МСК
    expect(msUntilMoscowMidnight(now)).toBeCloseTo(24 * 3600000 - 1000, -2);
  });

  test('время сброса лимита форматируется как HH:MM', () => {
    expect(nextResetTimeMoscow(new Date('2026-10-04T20:00:00Z'))).toBe('00:00');
  });
});
