export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/apps', '<rootDir>/packages'],
  testMatch: ['**/__tests__/**/*.test.js'],
  clearMocks: true,
  // сюиты с mongodb-memory-server поднимают бинарь mongod — параллельно
  // на одной машине они не укладываются в таймаут старта, гоняем последовательно
  maxWorkers: 1,
};
