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
  };
};

module.exports = {
  createBotApiClient,
};
