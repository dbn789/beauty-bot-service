// Суточные границы по Москве (ТЗ FR-B-080: сброс лимита в 00:00 Europe/Moscow).
// В России нет перехода на летнее время, поэтому 00:00 МСК = 21:00 UTC всегда.

const moscowDayKey = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

const msUntilMoscowMidnight = (now = new Date()) => {
  const midnightUtc = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 0, 0
  );
  const next = midnightUtc > now.getTime() ? midnightUtc : midnightUtc + 24 * 3600 * 1000;
  return next - now.getTime();
};

// «HH:MM» следующего сброса лимита по Москве
const nextResetTimeMoscow = (now = new Date()) => {
  const resetAt = new Date(now.getTime() + msUntilMoscowMidnight(now));
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit',
  }).format(resetAt);
};

module.exports = {
  moscowDayKey,
  msUntilMoscowMidnight,
  nextResetTimeMoscow,
};
