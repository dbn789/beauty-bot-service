// Клиент Internal API бота (ТЗ 9.1) для админки: x-api-key + таймауты.
const createBotApiClient = ({ baseUrl, apiKey, timeoutMs = 10000, fetchImpl } = {}) => {
  const doFetch = fetchImpl || ((url, init) => fetch(url, init));

  const request = async (path) => {
    const response = await doFetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const error = new Error(`bot api ${path}: http ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  };

  return {
    stats: async (days) => (await request(`/api/stats?days=${days}`)).json(),
    generations: async (params = {}) => {
      const query = new URLSearchParams(
        Object.entries(params).filter(([_k, v]) => v != null && v !== '')
      ).toString();
      return (await request(`/api/generations?${query}`)).json();
    },
    fileUrl: (id, ref) => `/preview/${id}?${ref}`,
    // проксирование файла: возвращает Response (body/content-type прокидываются наружу)
    file: (id, ref) => {
      const [kind, v] = ref.split('=');
      const query = kind === 'v' ? `v=${v}` : `kind=${kind}`;
      return request(`/files/${id}?${query}`);
    },
    standMeta: async () => (await request('/api/stand')).json(),
    // тело — сырой multipart с фото; генерация на BFL занимает до пары минут
    stand: async (body, contentType) => {
      const response = await doFetch(`${baseUrl.replace(/\/$/, '')}/api/stand`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': contentType },
        body,
        signal: AbortSignal.timeout(180000),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(json.error || `bot api /api/stand: http ${response.status}`);
        error.status = response.status;
        error.form = json.form || null;
        throw error;
      }
      return json;
    },
  };
};

module.exports = {
  createBotApiClient,
};
