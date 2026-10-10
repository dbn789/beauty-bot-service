// MockProvider (ТЗ FR-G-100): генерация без сети — цветные PNG с детерминированным
// оттенком от промпта. Опции для тестов: delayMs, failFirstN (S3: сначала N ошибок).
const { buildPng } = require('./png');

class MockProvider {
  constructor({ delayMs = 1500, failFirstN = 0 } = {}) {
    this.name = 'mock';
    this.model = 'mock-image';
    this.delayMs = delayMs;
    this.calls = 0;
    this.failFirstN = failFirstN;
  }

  async generate({ prompt, variants = 3 }) {
    this.calls += 1;
    if (this.failFirstN > 0) {
      this.failFirstN -= 1;
      const error = new Error('mock provider injected failure');
      error.code = 'provider_error';
      throw error;
    }
    const sleep = new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const seedBase = [...prompt].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 0xffffff, 7);
    const images = [];
    for (let i = 0; i < variants; i += 1) {
      const seed = (seedBase + i * 99991) % 0xffffff;
      const r = 40 + (seed % 200);
      const g = 40 + ((seed >> 8) % 200);
      const b = 40 + ((seed >> 16) % 200);
      images.push({
        buffer: buildPng(64, 64, (x, y) => [
          (r + x * 2) % 256,
          (g + y * 2) % 256,
          b,
        ]),
        width: 64,
        height: 64,
        providerTaskId: `mock-${seed}`,
      });
    }
    await sleep;
    return { images, model: this.model };
  }

  async health() {
    return true;
  }
}

module.exports = {
  MockProvider,
};
