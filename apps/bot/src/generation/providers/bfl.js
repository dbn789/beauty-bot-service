// BflProvider — официальный API Black Forest Labs (docs.bfl.ai, Э2 ТЗ).
// Флоу: POST /v1/<model> с input_image (data URI) → {id, polling_url} →
// поллинг до status "Ready" → result.sample (URL живёт 10 минут) → скачивание.
// Один вызов generate = N параллельных задач (по одной на вариант); лимит BFL —
// 24 активных задачи, при concurrency 2 и 3 вариантах максимум 6 — с запасом.
const { imageSize } = require('../../helpers/imageSize');

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

const abortError = () => Object.assign(new Error('bfl: aborted'), { code: 'provider_timeout' });

const mapHttpError = (status) => {
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 402) return 'provider_credits';
  if (status === 429) return 'provider_rate';
  if (RETRYABLE_HTTP.has(status)) return 'provider_error';
  return 'provider_error';
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

  // Сетевые сбои fetch (ECONNRESET/ETIMEDOUT/DNS) приходят как TypeError без кода —
  // оборачиваем в retryable 'network', иначе автоповтор не сработает
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

  async requestJson(url, init, { signal } = {}) {
    const response = await this.safeFetch(url, { ...init, signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_e) {
      body = { detail: text.slice(0, 200) };
    }
    if (!response.ok) {
      const message = (body && (body.detail || body.message)) || `bfl http ${response.status}`;
      throw Object.assign(new Error(message), { code: mapHttpError(response.status) });
    }
    return body;
  }

  async generate({ imageBuffer, mime = 'image/jpeg', prompt, variants = 1, signal } = {}) {
    if (!imageBuffer) {
      throw Object.assign(new Error('bfl: imageBuffer is required for editing'), { code: 'validation' });
    }
    if (signal && signal.aborted) throw abortError();
    const dataUri = `data:${mime};base64,${imageBuffer.toString('base64')}`;

    const submissions = await Promise.all(
      Array.from({ length: variants }, () =>
        this.requestJson(`${this.baseUrl}/${this.model}`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ prompt, input_image: dataUri }),
        }, { signal })
      )
    );

    const results = await Promise.all(
      submissions.map((submission) => this.waitForResult(submission.polling_url, signal))
    );

    const images = [];
    for (const result of results) {
      const response = await this.safeFetch(result.sampleUrl, { signal });
      if (!response.ok) {
        throw Object.assign(new Error(`bfl download http ${response.status}`), { code: 'network' });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const size = imageSize(buffer);
      images.push({
        buffer,
        width: size ? size.width : null,
        height: size ? size.height : null,
        providerTaskId: result.id,
      });
    }
    return { images, model: this.model };
  }

  async waitForResult(pollingUrl, signal) {
    for (;;) {
      if (signal && signal.aborted) throw abortError();
      const body = await this.requestJson(pollingUrl, {
        method: 'GET',
        headers: this.headers(false),
      }, { signal });

      if (body.status === 'Ready') {
        const sampleUrl = body.result && body.result.sample;
        if (!sampleUrl) {
          throw Object.assign(new Error('bfl: Ready without result.sample'), { code: 'provider_error' });
        }
        return { id: body.id, sampleUrl };
      }
      if (body.status === 'Error' || body.status === 'Failed') {
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
};
