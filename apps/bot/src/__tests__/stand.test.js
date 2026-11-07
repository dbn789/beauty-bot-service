const { buildPng } = require('../generation/providers/png');
const { parseMultipart } = require('../helpers/multipart');
const { parseStandRequest, catalog } = require('../generation/stand');

const photo = buildPng(640, 800, (x, y) => [(x * 3) % 256, (y * 5) % 256, (x + y) % 256]);

describe('стенд BFL', () => {
  test('каталог отдаёт модели EU API и текущую модель бота', () => {
    const meta = catalog('flux-2-pro');
    expect(meta.models.map((model) => model.id)).toEqual([
      'flux-2-max', 'flux-2-pro', 'flux-2-pro-preview', 'flux-2-flex', 'flux-2-klein-9b', 'flux-2-klein-4b',
    ]);
    expect(meta.currentModel).toBe('flux-2-pro');
    expect(meta.models.find((model) => model.id === 'flux-2-flex').controls).toEqual([
      'guidance', 'steps', 'promptUpsampling',
    ]);
  });

  test('pro: disable_pup и размер по выбранному пределу, guidance не уходит', () => {
    const built = parseStandRequest({
      model: 'flux-2-pro',
      variants: '2',
      prompt: 'keep the face, bob',
      resolution: '2mp',
      keepPrompt: '1',
      outputFormat: 'png',
      safetyTolerance: '2',
      seed: '42',
      guidance: '9',
    }, { mime: 'image/jpeg', buffer: photo });
    expect(built.error).toBeUndefined();
    expect(built.value.variants).toBe(2);
    expect(built.value.request.model).toBe('flux-2-pro');
    expect(built.value.request.fields.disable_pup).toBe(true);
    expect(built.value.request.fields.guidance).toBeUndefined();
    expect(built.value.request.fields.seed).toBe(42);
    expect(built.value.request.fields.output_format).toBe('png');
    // исходник 640×800 меньше 2 МП — стенд его не увеличивает
    expect(built.value.request).toMatchObject({ width: 640, height: 800 });

    const big = Buffer.from(photo);
    big.writeUInt32BE(4000, 16);
    big.writeUInt32BE(3000, 20);
    const scaled = parseStandRequest({
      model: 'flux-2-pro', variants: '1', prompt: 'keep', resolution: '2mp',
    }, { mime: 'image/png', buffer: big });
    const pixels = scaled.value.request.width * scaled.value.request.height;
    expect(pixels).toBeLessThanOrEqual(2000000);
    expect(pixels).toBeGreaterThan(1500000);
    expect(scaled.value.request.width % 32).toBe(0);
  });

  test('flex получает guidance и steps и не шлёт disable_pup', () => {
    const built = parseStandRequest({
      model: 'flux-2-flex',
      variants: '1',
      prompt: 'keep the face',
      resolution: 'cap1',
      keepPrompt: '1',
      guidance: '7.5',
      steps: '30',
    }, { mime: 'image/png', buffer: photo });
    expect(built.value.request.fields.guidance).toBe(7.5);
    expect(built.value.request.fields.steps).toBe(30);
    expect(built.value.request.fields.prompt_upsampling).toBe(false);
    expect(built.value.request.fields.disable_pup).toBeUndefined();
  });

  test('без фото и с чужой моделью — понятная ошибка', () => {
    expect(parseStandRequest({ model: 'nope', variants: '1', prompt: 'x', resolution: '2mp' }, null).error)
      .toMatch(/модель/);
    expect(parseStandRequest({
      model: 'flux-2-pro', variants: '1', prompt: 'x', resolution: '2mp',
    }, null).error).toMatch(/фото/);
  });
});

describe('multipart', () => {
  test('достаёт текстовое поле и файл', () => {
    const body = Buffer.from(
      '--b\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nкаре\r\n'
      + '--b\r\nContent-Disposition: form-data; name="image"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
      + 'BYTES\r\n--b--\r\n'
    );
    const parsed = parseMultipart(body, 'multipart/form-data; boundary=b');
    expect(parsed.fields.prompt).toBe('каре');
    expect(parsed.file.mime).toBe('image/jpeg');
    expect(parsed.file.buffer.toString()).toBe('BYTES');
  });
});
