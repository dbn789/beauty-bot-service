// Тесты BflProvider без сети: фейковый fetch по сценариям docs.bfl.ai.
const { BflProvider, mapHttpError } = require('../generation/providers/bfl');
const { isRetryableError } = require('../generation/service');
const { buildPng } = require('../generation/providers/png');

const png = buildPng(16, 16, (x, y) => [x * 8 % 256, y * 8 % 256, 128]);
const BASE = 'https://api.bfl.ai/v1';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});
const binaryResponse = (buffer) => ({
  ok: true,
  status: 200,
  text: async () => '{}}',
  arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
});

// Собирает fetch, отвечающий по сценариям на POST /model, GET polling, GET sample.
// Опции: pollFlakes (номера опросов, бросающие сетевую ошибку), failSubmitIndexes
// (номера POST, всегда 503), textError (response.text() бросает — обрыв тела).
const makeFetch = ({
  submits = [],
  polls = [],
  downloadError,
  submitStatus = 200,
  pollFlakes = [],
  failSubmitIndexes = [],
  textError = false,
} = {}) => {
  const submitted = [];
  const pollLog = [];
  const pollsQueue = [...polls];
  let pollNumber = 0;
  return {
    submitted,
    pollLog,
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        submitted.push(JSON.parse(init.body));
        if (failSubmitIndexes.includes(submitted.length)) {
          return jsonResponse(503, { detail: 'submit boom' });
        }
        return jsonResponse(submitStatus, submits.shift() || {
          id: `task-${submitted.length}`,
          polling_url: `${BASE}/get_result?id=${submitted.length}`,
        });
      }
      if (url.startsWith(`${BASE}/get_result`)) {
        pollNumber += 1;
        if (pollFlakes.includes(pollNumber)) {
          const error = new TypeError('fetch failed');
          error.cause = { code: 'UND_ERR_SOCKET' };
          throw error;
        }
        const next = pollsQueue.shift() || { status: 'Ready', id: 'task-1', result: { sample: 'https://delivery.bfl.ai/x.png' } };
        pollLog.push(next.status);
        if (textError) {
          return { ok: true, status: 200, text: async () => { throw new TypeError('terminated'); } };
        }
        return jsonResponse(200, next);
      }
      if (url.startsWith('https://delivery')) {
        if (downloadError) return jsonResponse(500, { detail: 'boom' });
        return binaryResponse(png);
      }
      return jsonResponse(404, { detail: `unexpected url ${url}` });
    },
  };
};

const makeProvider = (fetchImpl, extra = {}) =>
  new BflProvider({
    apiKey: 'test-key',
    model: 'flux-2-pro',
    baseUrl: BASE,
    pollIntervalMs: 1,
    fetchImpl,
    ...extra,
  });

describe('BflProvider: happy path', () => {
  test('POST с input_image (data URI) + x-key → поллинг → Ready → скачивание', async () => {
    const harness = makeFetch({
      polls: [{ status: 'Processing' }, { status: 'Ready', id: 'task-1', result: { sample: 'https://delivery.bfl.ai/x.png' } }],
    });
    const provider = makeProvider(harness.fetchImpl);

    const result = await provider.generate({
      imageBuffer: png,
      mime: 'image/png',
      prompt: 'Edit the hairstyle: bob. Keep the face.',
      variants: 2,
    });

    expect(result.model).toBe('flux-2-pro');
    expect(result.images).toHaveLength(2);
    expect(result.images[0].width).toBe(16);
    expect(result.images[0].height).toBe(16);
    expect(result.images[0].providerTaskId).toBe('task-1');
    expect(harness.pollLog).toEqual(['Processing', 'Ready', 'Ready']); // 2 варианта: 2 опроса + дефолт

    // отправка: правильный заголовок и data URI с промптом
    expect(harness.submitted).toHaveLength(2);
    expect(harness.submitted[0].prompt).toContain('bob');
    expect(harness.submitted[0].input_image).toMatch(/^data:image\/png;base64,/);
    // размеры выхода прокинуты, кратны 32 (кап цены за мегапиксель)
    expect(harness.submitted[0].width % 32).toBe(0);
    expect(harness.submitted[0].height % 32).toBe(0);
    // боевой вызов не шлёт ручки стенда
    expect(harness.submitted[0].disable_pup).toBeUndefined();
  });

  test('стенд подменяет модель, размер и доп. поля схемы', async () => {
    const urls = [];
    const fetchImpl = async (url, init = {}) => {
      urls.push(url);
      if (init.method === 'POST') return jsonResponse(200, { id: 't', polling_url: `${BASE}/get_result?id=1` });
      if (url.startsWith(`${BASE}/get_result`)) return jsonResponse(200, { status: 'Ready', id: 't', result: { sample: 'https://delivery.bfl.ai/x.png' } });
      return binaryResponse(png);
    };
    const result = await makeProvider(fetchImpl).generate({
      imageBuffer: png,
      prompt: 'keep the face',
      variants: 1,
      request: {
        model: 'flux-2-max',
        width: 832,
        height: 1216,
        fields: { disable_pup: true, safety_tolerance: 2, output_format: 'png', seed: 7 },
      },
    });
    expect(urls[0]).toBe(`${BASE}/flux-2-max`);
    expect(result.model).toBe('flux-2-max');
    expect(result.request).toEqual({
      prompt: 'keep the face',
      width: 832,
      height: 1216,
      disable_pup: true,
      safety_tolerance: 2,
      output_format: 'png',
      seed: 7,
    });
  });

  test('x-key прокидывается в заголовки', async () => {
    const captured = [];
    const fetchImpl = async (url, init = {}) => {
      captured.push(init.headers);
      if (init.method === 'POST') return jsonResponse(200, { id: 't', polling_url: `${BASE}/get_result?id=1` });
      if (url.startsWith(`${BASE}/get_result`)) return jsonResponse(200, { status: 'Ready', id: 't', result: { sample: 'https://delivery.bfl.ai/x.png' } });
      return binaryResponse(png);
    };
    await makeProvider(fetchImpl).generate({ imageBuffer: png, prompt: 'p', variants: 1 });
    expect(captured[0]['x-key']).toBe('test-key');
  });
});

describe('BflProvider: ошибки и классификация', () => {
  test('402 (кредиты кончились) — non-retryable provider_credits', async () => {
    const error = Object.assign(new Error('x'), { code: mapHttpError(402) });
    expect(error.code).toBe('provider_credits');
    expect(isRetryableError(error)).toBe(false);
  });

  test('401/403 — provider_auth, non-retryable', () => {
    expect(mapHttpError(401)).toBe('provider_auth');
    expect(isRetryableError({ code: mapHttpError(401) })).toBe(false);
  });

  test('429 и 5xx — retryable', () => {
    expect(mapHttpError(429)).toBe('provider_rate');
    expect(isRetryableError({ code: 'provider_rate' })).toBe(true);
    expect(mapHttpError(503)).toBe('provider_error');
    expect(isRetryableError({ code: mapHttpError(503) })).toBe(true);
  });

  test('задача провалилась на стороне BFL → provider_error', async () => {
    const harness = makeFetch({
      polls: [{ status: 'Failed', id: 't', details: 'safety' }],
    });
    await expect(
      makeProvider(harness.fetchImpl).generate({ imageBuffer: png, prompt: 'p', variants: 1 })
    ).rejects.toMatchObject({ code: 'provider_error' });
  });

  test('модерация отклонила задачу → provider_moderated, без повторов (риск 2)', async () => {
    const harness = makeFetch({
      polls: [{ status: 'Content Moderated', id: 't' }],
    });
    const error = await makeProvider(harness.fetchImpl)
      .generate({ imageBuffer: png, prompt: 'p', variants: 1 })
      .catch((e) => e);
    expect(error.code).toBe('provider_moderated');
    expect(isRetryableError(error)).toBe(false);
  });

  test('POST 400 (наша ошибка) → provider_client, non-retryable (риск 3)', async () => {
    const harness = makeFetch({ submitStatus: 400 });
    const error = await makeProvider(harness.fetchImpl)
      .generate({ imageBuffer: png, prompt: 'p', variants: 1 })
      .catch((e) => e);
    expect(error.code).toBe('provider_client');
    expect(isRetryableError(error)).toBe(false);
  });

  test('обрыв чтения тела (TypeError: terminated) → network, retryable (3a7de2d риск 2)', async () => {
    const harness = makeFetch({ textError: true });
    const error = await makeProvider(harness.fetchImpl)
      .generate({ imageBuffer: png, prompt: 'p', variants: 1 })
      .catch((e) => e);
    expect(error.code).toBe('network');
    expect(isRetryableError(error)).toBe(true);
  });

  test('сетевой сбой одного опроса — ретрай внутри, БЕЗ ре-сабмита задач (двойная оплата)', async () => {
    const harness = makeFetch({ pollFlakes: [1] });
    const result = await makeProvider(harness.fetchImpl).generate({
      imageBuffer: png, prompt: 'p', variants: 3,
    });
    expect(result.images).toHaveLength(3);
    expect(harness.submitted).toHaveLength(3); // не 6 — задачи не отправляются заново
  });

  test('один вариант упал на submit — остальные выжили, ре-сабмита нет (риск 1)', async () => {
    const harness = makeFetch({ failSubmitIndexes: [2] });
    const result = await makeProvider(harness.fetchImpl).generate({
      imageBuffer: png, prompt: 'p', variants: 3,
    });
    expect(result.images).toHaveLength(2);
    expect(harness.submitted).toHaveLength(3);
  });

  test('не выжил ни один вариант — бросается ошибка первого варианта', async () => {
    const harness = makeFetch({ submitStatus: 503 });
    await expect(
      makeProvider(harness.fetchImpl).generate({ imageBuffer: png, prompt: 'p', variants: 2 })
    ).rejects.toMatchObject({ code: 'provider_error' });
  });

  test('POST вернул 402 → код provider_credits', async () => {
    const harness = makeFetch({ submitStatus: 402 });
    await expect(
      makeProvider(harness.fetchImpl).generate({ imageBuffer: png, prompt: 'p', variants: 1 })
    ).rejects.toMatchObject({ code: 'provider_credits' });
  });

  test('скачивание результата 5xx → network (retryable)', async () => {
    const harness = makeFetch({ downloadError: true });
    await expect(
      makeProvider(harness.fetchImpl).generate({ imageBuffer: png, prompt: 'p', variants: 1 })
    ).rejects.toMatchObject({ code: 'network' });
  });
});

describe('BflProvider: отмена', () => {
  test('pre-aborted сигнал → provider_timeout без единого запроса', async () => {
    const harness = makeFetch({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeProvider(harness.fetchImpl).generate({
        imageBuffer: png, prompt: 'p', variants: 1, signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'provider_timeout' });
  });

  test('без imageBuffer — validation', async () => {
    await expect(makeProvider(makeFetch({}).fetchImpl).generate({ prompt: 'p' }))
      .rejects.toMatchObject({ code: 'validation' });
  });
});
