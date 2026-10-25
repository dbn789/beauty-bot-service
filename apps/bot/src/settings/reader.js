// Живое чтение настроек ботом из MongoDB (ТЗ: управление из админки без деплоя).
// Кэш с TTL: частые апдейты не бьют по БД; при ошибке обновления живём
// на последнем известном значении; если ни разу не прочитали — дефолты.
const createSettingsReader = ({ models, ttlMs = 30000, now = () => Date.now() } = {}) => {
  const cache = new Map(); // section → { data, fetchedAt }
  let dbReads = 0;

  const defaults = {
    users: { accessMode: 'off', lists: { whitelist: [], blacklist: [] } },
  };

  const get = async (section) => {
    const cached = cache.get(section);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return cached.data;
    }
    try {
      const doc = await models.Setting.findOne({ section }).lean();
      dbReads += 1;
      const data = { ...(defaults[section] || {}), ...(doc && doc.data) };
      cache.set(section, { data, fetchedAt: now() });
      return data;
    } catch (_error) {
      // БД недоступна: отдаём протухшее значение, если есть (лучше старый режим
      // доступа, чем «все настройки обнулились»)
      if (cached) return cached.data;
      return defaults[section] || {};
    }
  };

  return {
    get,
    invalidate: (section) => cache.delete(section),
    get dbReads() { return dbReads; },
  };
};

module.exports = {
  createSettingsReader,
};
