// Подключение MongoDB + состояние для /health (ТЗ FR-I-090).
const mongoose = require('mongoose');

const connectDb = async ({ mongoUri, logger }) => {
  if (!mongoUri) {
    logger.warn('MONGO_URI is not set: db unavailable, features requiring db are disabled');
    return null;
  }
  mongoose.connection.on('error', (error) => {
    logger.error({ err: error.message }, 'mongo connection error');
  });
  await mongoose.connect(mongoUri);
  logger.info('mongo connected');
  return mongoose.connection;
};

const dbState = () => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const state = states[mongoose.connection.readyState];
  return state === 'connected' ? 'ok' : state;
};

const disconnectDb = async () => {
  await mongoose.disconnect();
};

module.exports = {
  connectDb,
  dbState,
  disconnectDb,
};
