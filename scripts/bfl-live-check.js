// Живая проверка BflProvider (Э2). Расходует кредиты bfl.ai!
//
//   set -a; source .env; set +a
//   node scripts/bfl-live-check.js                 # сгенерировать портрет → редактирование
//   node scripts/bfl-live-check.js photo.jpg       # редактирование своего фото
//   BFL_MODEL=flux-2-klein-9b node ...             # сравнение моделей
//
// Результаты: tmp-live/ (gitignored). Ключ читается из env и нигде не печатается.
const fs = require('fs');
const path = require('path');
require('dns').setDefaultResultOrder('ipv4first'); // сети без IPv6: см. apps/bot/index.js
const { BflProvider } = require('../apps/bot/src/generation/providers/bfl');
const { buildHairstylePrompt, PRESETS_CATALOG } = require('@beauty/shared');

const main = async () => {
  if (!process.env.BFL_API_KEY) {
    console.error('BFL_API_KEY is not set');
    process.exit(1);
  }
  const model = process.env.BFL_MODEL || 'flux-2-pro';
  const provider = new BflProvider({
    apiKey: process.env.BFL_API_KEY,
    model,
    ...(process.env.BFL_BASE_URL ? { baseUrl: process.env.BFL_BASE_URL } : {}),
  });

  const outDir = path.join(__dirname, '..', 'tmp-live');
  fs.mkdirSync(outDir, { recursive: true });

  let sourceBuffer;
  let mime = 'image/jpeg';
  const argPhoto = process.argv[2];
  if (argPhoto) {
    sourceBuffer = fs.readFileSync(argPhoto);
    if (/\.png$/i.test(argPhoto)) mime = 'image/png';
  } else {
    console.log(`[${model}] генерирую тестовый портрет (t2i, ~1 картинка)…`);
    const t0 = Date.now();
    const t2i = await provider.requestJson(`${provider.baseUrl}/${model}`, {
      method: 'POST',
      headers: provider.headers(),
      body: JSON.stringify({
        prompt: 'photorealistic portrait photo of a young woman, front view, neutral studio background, soft light, shoulders visible',
        width: 832,
        height: 1216,
      }),
    }, {});
    const done = await provider.waitForResult(t2i.polling_url);
    sourceBuffer = Buffer.from(await (await fetch(done.sampleUrl)).arrayBuffer());
    fs.writeFileSync(path.join(outDir, 'portrait-source.jpg'), sourceBuffer);
    console.log(`портрет готов за ${((Date.now() - t0) / 1000).toFixed(1)} с → tmp-live/portrait-source.jpg`);
  }

  const preset = PRESETS_CATALOG.find((p) => p.code === 'bob_classic');
  const prompt = buildHairstylePrompt({ request: preset.promptEn });
  console.log(`[${model}] редактирование: ${preset.titleRu} · 3 варианта…`);

  const started = Date.now();
  const result = await provider.generate({
    imageBuffer: sourceBuffer,
    mime,
    prompt,
    variants: 3,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  result.images.forEach((image, i) => {
    const name = `${stamp}-${model}-variant-${i + 1}.png`;
    fs.writeFileSync(path.join(outDir, name), image.buffer);
  });

  console.log(`готово за ${seconds} с; варианты: ${result.images.length}; размеры: ${
    result.images.map((i) => `${i.width}x${i.height}`).join(', ')
  }; task ids: ${result.images.map((i) => i.providerTaskId).join(', ')}`);
  console.log('файлы в tmp-live/ — оцените глазами: лицо должно остаться прежним, меняется только причёска.');
};

main().catch((error) => {
  console.error('live check failed:', error.code ? `[${error.code}]` : '', error.message);
  process.exit(1);
});
