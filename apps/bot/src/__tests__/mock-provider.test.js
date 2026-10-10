const { MockProvider } = require('../generation/providers/mock');

describe('MockProvider (FR-G-100)', () => {
  test('возвращает запрошенное число валидных PNG', async () => {
    const provider = new MockProvider({ delayMs: 5 });
    const result = await provider.generate({ imageRef: 'sources/u/x.jpg', prompt: 'bob', variants: 3 });
    expect(result.images).toHaveLength(3);
    for (const image of result.images) {
      expect(image.buffer[0]).toBe(0x89);
      expect(image.buffer[1]).toBe(0x50);
      expect(image.buffer[2]).toBe(0x4e);
      expect(image.buffer[3]).toBe(0x47);
      expect(image.width).toBe(64);
    }
    expect(result.model).toBe('mock-image');
    expect(await provider.health()).toBe(true);
  });

  test('failFirstN: сначала ошибка, потом успех (для S3-тестов)', async () => {
    const provider = new MockProvider({ delayMs: 5, failFirstN: 1 });
    await expect(provider.generate({ prompt: 'x', variants: 1 })).rejects.toMatchObject({ code: 'provider_error' });
    const result = await provider.generate({ prompt: 'x', variants: 1 });
    expect(result.images).toHaveLength(1);
    expect(provider.calls).toBe(2);
  });
});
