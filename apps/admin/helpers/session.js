// Stateless-сессии админки: подписанный HMAC-SHA256 cookie `login.exp.mac`.
// Без внешних зависимостей; SESSION_SECRET обязателен в production.
const crypto = require('crypto');

const createSession = (secret) => {
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET must be set (at least 16 characters)');
  }
  const key = crypto.createHash('sha256').update(String(secret)).digest();

  const mac = (payload) => crypto.createHmac('sha256', key).update(payload).digest('hex');

  const sign = (login, ttlMs) => {
    const expires = Date.now() + ttlMs;
    const payload = `${login}|${expires}`;
    return `${Buffer.from(payload).toString('base64url')}.${mac(payload)}`;
  };

  const verify = (token) => {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const dot = token.lastIndexOf('.');
    const payloadB64 = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    let payload;
    try {
      payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    } catch (_e) {
      return null;
    }
    const expected = mac(payload);
    // длины равны всегда (hex), сравнение по времени
    if (signature.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return null;
    }
    const [login, expires] = payload.split('|');
    if (!login || !expires || Number(expires) < Date.now()) return null;
    return login;
  };

  return { sign, verify };
};

module.exports = {
  createSession,
};
