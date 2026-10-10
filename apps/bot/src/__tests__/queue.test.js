const { LimiterQueue } = require('../generation/queue');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('LimiterQueue (FR-G-090)', () => {
  test('не превышает concurrency', async () => {
    const queue = new LimiterQueue({ concurrency: 2 });
    let running = 0;
    let maxRunning = 0;

    const task = async (id) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await delay(30);
      running -= 1;
      return id;
    };

    const results = await Promise.all([
      queue.add(() => task(1)),
      queue.add(() => task(2)),
      queue.add(() => task(3)),
      queue.add(() => task(4)),
      queue.add(() => task(5)),
    ]);

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  test('ошибка одной задачи не ломает очередь', async () => {
    const queue = new LimiterQueue({ concurrency: 1 });
    const failing = queue.add(async () => { throw new Error('boom'); });
    const ok = queue.add(async () => 'fine');
    await expect(failing).rejects.toThrow('boom');
    await expect(ok).resolves.toBe('fine');
  });

  test('size/busy отражают состояние', async () => {
    const queue = new LimiterQueue({ concurrency: 1 });
    const first = queue.add(() => delay(30));
    const second = queue.add(() => delay(30));
    expect(queue.size).toBe(1);
    expect(queue.busy).toBe(true);
    await Promise.all([first, second]);
    expect(queue.size).toBe(0);
    expect(queue.busy).toBe(false);
  });
});
