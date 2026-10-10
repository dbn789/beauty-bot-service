// BflProvider — официальный API Black Forest Labs (ТЗ FR-G-010). Интеграция на этапе Э2:
// сейчас явная заглушка, чтобы ошибочный GENERATION_PROVIDER=bfl падал с понятной причиной.
class BflProvider {
  constructor() {
    this.name = 'bfl';
    this.model = 'flux.2-flex';
    this.ready = false;
  }

  async generate() {
    throw Object.assign(new Error('bfl provider: интеграция на этапе Э2 (ТЗ, раздел 12)'), {
      code: 'provider_unavailable',
    });
  }

  async health() {
    return false;
  }
}

module.exports = {
  BflProvider,
};
