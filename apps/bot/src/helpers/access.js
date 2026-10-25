// Чистая логика доступа к боту (ТЗ: белый/чёрный список, режим off).

const ACCESS_MODES = Object.freeze(['off', 'whitelist', 'blacklist']);

/**
 * @param {string} mode off | whitelist | blacklist
 * @param {Array<{tgId:number}>} entries записи списка
 * @param {number} tgId идентификатор пользователя Telegram
 * @returns {boolean} разрешён ли доступ
 */
const checkAccess = (mode, entries, tgId) => {
  if (mode === 'whitelist') {
    return (entries || []).some((entry) => entry.tgId === tgId);
  }
  if (mode === 'blacklist') {
    return !(entries || []).some((entry) => entry.tgId === tgId);
  }
  return true; // off: фильтр отключен — доступ всем
};

// Настройка из Mongo: два списка живут рядом, режим выбирает, какой применять.
const resolveAccess = (data) => {
  const mode = data && ACCESS_MODES.includes(data.accessMode) ? data.accessMode : 'off';
  if (mode === 'off') return { mode, entries: [] };
  const lists = (data && data.lists) || {};
  const entries = Array.isArray(lists[mode]) ? lists[mode] : [];
  return { mode, entries };
};

module.exports = {
  ACCESS_MODES,
  checkAccess,
  resolveAccess,
};
