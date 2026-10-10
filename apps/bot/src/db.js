// Подключение MongoDB + состояние для /health (ТЗ FR-I-090).
const mongoose = require('mongoose');

const connectDb = async ({ mongoUri, logger }) => {
  if (!mongoUri) {
    logger.warn('MONGO_URI is not set: db unavailable, features requiring db are disabled');
    return null;
  }
  try {
    mongoose.connection.on('error', (error) => {
      logger.error({ err: error.message }, 'mongo connection error');
    });
    await mongoose.connect(mongoUri);
    logger.info('mongo connected');
    return mongoose.connection;
  } catch (error) {
    // причина недоступности — в лог, а не только факт (ревью 3e35882, риск 7)
    logger.error({ err: error.message }, 'mongo connect failed');
    return null;
  }
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
