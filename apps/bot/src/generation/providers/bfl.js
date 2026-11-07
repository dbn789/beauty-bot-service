// BflProvider — официальный API Black Forest Labs (docs.bfl.ai, Э2 ТЗ).
// Флоу: POST /v1/<model> с input_image (data URI) → {id, polling_url} →
// поллинг до финального статуса → скачивание result.sample (URL живёт 10 минут).
//
// Экономика (ревью 2c82805/3a7de2d, риск «двойная оплата»):
// - варианты независимы: сбой одного не выбрасывает оплаченные задачи остальных
//   (allSettled + ретраи идемпотентных GET-опросов и скачивания ВНУТРИ варианта);
// - повтор всего запроса (сервис-уровень) происходит только если не выжил
//   ни один вариант;
// - если выжили не все — отдаём сколько есть (ТЗ FR-G-050);
// - submit не идемпотентен: ретраится максимум один раз и только на сетевой сбой.
const { imageSize } = require('../../helpers/imageSize');

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

// финальные «плохие» статусы задачи BFL: Error/Failed — технические (повтор
// может помочь), модерация и потерянная задача — повтор бессмысленен
const TASK_FAILED_RETRYABLE = new Set(['Error', 'Failed']);
const TASK_REJECTED = new Set(['Request Moderated', 'Content Moderated', 'Task not found']);

// выход не больше ~1.1 МП: цена BFL считается за мегапиксель, а фото клиента
// с телефона может быть 12 МП — кап держит стоимость у базовой
const OUTPUT_PIXELS_CAP = 1100000;

const abortError = () => Object.assign(new Error('bfl: aborted'), { code: 'provider_timeout' });

const mapHttpError = (status) => {
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 402) return 'provider_credits';
  if (status === 429) return 'provider_rate';
  if (RETRYABLE_HTTP.has(status)) return 'provider_error';
  // 400/404/413/422… — ошибка на нашей стороне (размер, имя модели), повтор не поможет
  return 'provider_client';
};

const detailText = (body) => {
  const detail = body && (body.detail || body.message);
  if (detail == null) return '';
  return typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200);
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) {
    reject(abortError());
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError());
  };
  const timer = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

// Повтор только сетевых сбоев (идемпотентные запросы), с линейным backoff
const withNetworkRetries = async (fn, { attempts = 3, backoffMs = 500, signal } = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || error.code !== 'network') throw error;
      await sleep(backoffMs * attempt, signal);
    }
  }
};

// Размеры выхода: аспект исходника, площадь не выше капа, кратность 32.
// Кап ~1.1 МП — поведение бота. Стенд передаёт больший pixelCap (до 4 МП, потолок FLUX.2).
const round32 = (value) => Math.max(32, Math.round(value / 32) * 32);
const fitOutputSize = (buffer, pixelCap = OUTPUT_PIXELS_CAP) => {
  const size = imageSize(buffer);
  if (!size) return {};
  let { width, height } = size;
  const cap = pixelCap > 0 ? pixelCap : OUTPUT_PIXELS_CAP;
  if (width * height > cap) {
    const scale = Math.sqrt(cap / (width * height));
    width *= scale;
    height *= scale;
  }
  return { width: round32(width), height: round32(height) };
};
const outputSize = (buffer) => fitOutputSize(buffer, OUTPUT_PIXELS_CAP);

// Модели POST /v1/<id> на api.eu.bfl.ai (OpenAPI, ноябрь 2026).
// controls — какие поля схема этой модели принимает сверх общих.
const BFL_MODELS = Object.freeze([
  {
    id: 'flux-2-max',
    title: 'FLUX.2 [max]',
    note: 'Самое точное редактирование и следование промпту.',
    priceUsd: 0.07,
    controls: ['disablePup'],
  },
  {
    id: 'flux-2-pro',
    title: 'FLUX.2 [pro]',
    note: 'Модель бота сейчас. Рабочая лошадка для правки по референсу.',
    priceUsd: 0.045,
    controls: ['disablePup'],
  },
  {
    id: 'flux-2-pro-preview',
    title: 'FLUX.2 [pro] preview',
    note: 'Сюда BFL сначала выкатывает улучшения pro. Для постоянного прода не закреплена.',
    priceUsd: 0.045,
    controls: ['disablePup'],
  },
  {
    id: 'flux-2-flex',
    title: 'FLUX.2 [flex]',
    note: 'Единственная с guidance и steps: ими крутят, насколько жёстко держать текст.',
    priceUsd: 0.06,
    controls: ['guidance', 'steps', 'promptUpsampling'],
  },
  {
    id: 'flux-2-klein-9b',
    title: 'FLUX.2 [klein] 9B',
    note: 'Быстрее и дешевле. Причёску держит слабее pro.',
    priceUsd: 0.015,
    controls: [],
  },
  {
    id: 'flux-2-klein-4b',
    title: 'FLUX.2 [klein] 4B',
    note: 'Самая дешёвая. Для сравнения цены, не для финального качества.',
    priceUsd: 0.014,
    controls: [],
  },
]);

const RESOLUTIONS = Object.freeze([
  { id: 'cap1', megapixels: 1.1, pixels: 1100000, title: 'Как в боте сейчас, около 1.1 МП' },
  { id: '2mp', megapixels: 2, pixels: 2000000, title: '2 МП — больше деталей лица' },
  { id: '4mp', megapixels: 4, pixels: 4000000, title: '4 МП — потолок FLUX.2' },
]);

class BflProvider {
  constructor({
    apiKey,
    model = 'flux-2-pro',
    baseUrl = 'https://api.bfl.ai/v1',
    pollIntervalMs = 1000,
    fetchImpl,
  } = {}) {
    if (!apiKey) {
      throw new Error('BflProvider: apiKey is required');
    }
    this.name = 'bfl';
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.pollIntervalMs = pollIntervalMs;
    this.fetchImpl = fetchImpl || ((url, init) => fetch(url, init));
  }

  headers(json = true) {
    return {
      accept: 'application/json',
      'x-key': this.apiKey,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  // Сетевые сбои fetch (ECONNRESET/ETIMEDOUT/DNS) и обрывы ЧТЕНИЯ ТЕЛА приходят
  // без кода — оборачиваем в retryable 'network', иначе автоповтор не сработает
  async safeFetch(url, init = {}) {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
        throw abortError();
      }
      const cause = error && error.cause ? ` (${error.cause.code || error.cause.message || ''})` : '';
      throw Object.assign(new Error(`bfl network error${cause}: ${error.message}`), { code: 'network' });
    }
  }

  async readText(response) {
    try {
      return await response.text();
    } catch (error) {
      throw Object.assign(new Error(`bfl network error (body): ${error.message}`), { code: 'network' });
    }
  }

  async requestJson(url, init, { signal } = {}) {
    const response = await this.safeFetch(url, { ...init, signal });
    const text = await this.readText(response);
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_e) {
      body = { detail: text.slice(0, 200) };
    }
    if (!response.ok) {
      const message = detailText(body) || `bfl http ${response.status}`;
      throw Object.assign(new Error(message), { code: mapHttpError(response.status) });
    }
    return body;
  }

  async generate({ imageBuffer, mime = 'image/jpeg', prompt, variants = 1, signal, request = null } = {}) {
    if (!imageBuffer) {
      throw Object.assign(new Error('bfl: imageBuffer is required for editing'), { code: 'validation' });
    }
    if (signal && signal.aborted) throw abortError();
    const dataUri = `data:${mime};base64,${imageBuffer.toString('base64')}`;
    // request задаёт стенд: своя модель, свой размер и доп. поля схемы.
    // Обычный вызов бота request не передаёт — тело остаётся прежним.
    const modelName = request && request.model ? request.model : this.model;
    const sized = request && request.width
      ? { width: request.width, height: request.height }
      : outputSize(imageBuffer);
    const payload = {
      prompt,
      input_image: dataUri,
      ...(sized.width ? { width: sized.width, height: sized.height } : {}),
      ...(request && request.fields ? request.fields : {}),
    };

    const submitOne = () => this.requestJson(`${this.baseUrl}/${modelName}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    }, { signal });

    // submit не идемпотентен: не больше одной повторной попытки на сетевой сбой
    const submissions = await Promise.allSettled(
      Array.from({ length: variants }, () =>
        withNetworkRetries(submitOne, { attempts: 2, signal }))
    );

    const variantJobs = [];
    let firstError = null;
    submissions.forEach((outcome) => {
      if (outcome.status === 'fulfilled') {
        variantJobs.push(this.collectVariant(outcome.value, signal));
      } else if (!firstError) {
        firstError = outcome.reason;
      }
    });

    const collected = await Promise.allSettled(variantJobs);
    const images = [];
    for (const outcome of collected) {
      if (outcome.status === 'fulfilled') images.push(outcome.value);
      else if (!firstError) firstError = outcome.reason;
    }

    if (images.length === 0) {
      // не выжил ни один вариант — пусть сервис-уровень решает (один ретрай всего запроса)
      throw firstError || Object.assign(new Error('bfl: no variants succeeded'), { code: 'provider_error' });
    }
    const echo = { ...payload };
    delete echo.input_image;
    return {
      images,
      model: modelName,
      ...(request ? { request: echo } : {}),
    };
  }

  // Опрос + скачивание одного варианта, с внутренними ретраями идемпотентных GET
  async collectVariant(submission, signal) {
    const done = await this.waitForResult(submission.polling_url, signal);
    const buffer = await withNetworkRetries(async () => {
      const response = await this.safeFetch(done.sampleUrl, { signal });
      if (!response.ok) {
        throw Object.assign(new Error(`bfl download http ${response.status}`), {
          code: RETRYABLE_HTTP.has(response.status) ? 'network' : 'provider_client',
        });
      }
      try {
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw Object.assign(new Error(`bfl network error (download body): ${error.message}`), { code: 'network' });
      }
    }, { attempts: 3, signal });

    const size = imageSize(buffer);
    return {
      buffer,
      width: size ? size.width : null,
      height: size ? size.height : null,
      providerTaskId: done.id,
    };
  }

  async waitForResult(pollingUrl, signal) {
    for (;;) {
      if (signal && signal.aborted) throw abortError();
      const body = await withNetworkRetries(
        () => this.requestJson(pollingUrl, { method: 'GET', headers: this.headers(false) }, { signal }),
        { attempts: 3, signal }
      );

      if (body.status === 'Ready') {
        const sampleUrl = body.result && body.result.sample;
        if (!sampleUrl) {
          throw Object.assign(new Error('bfl: Ready without result.sample'), { code: 'provider_error' });
        }
        return { id: body.id, sampleUrl };
      }
      if (TASK_REJECTED.has(body.status)) {
        const details = JSON.stringify(body).slice(0, 300);
        throw Object.assign(new Error(`bfl task rejected: ${details}`), { code: 'provider_moderated' });
      }
      if (TASK_FAILED_RETRYABLE.has(body.status)) {
        const details = JSON.stringify(body).slice(0, 300);
        throw Object.assign(new Error(`bfl task ${body.status}: ${details}`), { code: 'provider_error' });
      }
      await sleep(this.pollIntervalMs, signal);
    }
  }

  async health() {
    try {
      await this.requestJson(`${this.baseUrl}/credits`, {
        method: 'GET',
        headers: this.headers(false),
      }, {});
      return true;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = {
  BflProvider,
  mapHttpError,
  BFL_MODELS,
  RESOLUTIONS,
  fitOutputSize,
  OUTPUT_PIXELS_CAP,
};
