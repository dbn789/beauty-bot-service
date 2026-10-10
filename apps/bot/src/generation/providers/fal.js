// FalProvider — fal.ai (ТЗ FR-G-010). Интеграция на этапе Э2, сейчас явная заглушка.
class FalProvider {
  constructor() {
    this.name = 'fal';
    this.model = 'flux-2-dev';
    this.ready = false;
  }

  async generate() {
    throw Object.assign(new Error('fal provider: интеграция на этапе Э2 (ТЗ, раздел 12)'), {
      code: 'provider_unavailable',
    });
  }

  async health() {
    return false;
  }
}

module.exports = {
  FalProvider,
};
