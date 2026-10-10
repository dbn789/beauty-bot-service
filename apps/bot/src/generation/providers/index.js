// Реестр провайдеров генерации (ТЗ FR-G-010): выбор через GENERATION_PROVIDER.
const { MockProvider } = require('./mock');
const { BflProvider } = require('./bfl');
const { FalProvider } = require('./fal');

const getProvider = (name, options = {}) => {
  switch (name) {
    case 'bfl':
      return new BflProvider(options);
    case 'fal':
      return new FalProvider(options);
    case 'mock':
      return new MockProvider(options);
    default:
      throw new Error(`unknown generation provider: ${name}`);
  }
};

module.exports = {
  getProvider,
};
