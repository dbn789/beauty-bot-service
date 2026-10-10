const pino = require('pino');

// Единый логгер контейнера: JSON, уровень из env (ТЗ FR-I-100).
// В лог запрещено попадание секретов и ПДн — контроль тестами и ревью.
const createLogger = ({ env = 'development' } = {}) => pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { app: 'beauty-bot', env },
});

module.exports = {
  createLogger,
};
