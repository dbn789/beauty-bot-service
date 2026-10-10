const { buildPng } = require('../generation/providers/png');
const { imageSize } = require('../helpers/imageSize');

// шумный пиксель — чтобы PNG не сжимался в пустоту и проходил порог размера
const noise = (seed) => (x, y) => [(x * 7 + seed) % 256, (y * 13 + seed) % 256, (x * y + seed) % 256];

describe('imageSize', () => {
  test('PNG: размеры из IHDR', () => {
    const png = buildPng(123, 45, noise(1));
    expect(imageSize(png)).toEqual({ width: 123, height: 45 });
  });

  test('JPEG: размеры из SOF-сегмента (синтетический буфер)', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xc0, 0x00, 0x0b, // SOF0, длина 11
      0x08, // разрядность
      0x01, 0x2c, // height 300
      0x02, 0x58, // width 600
      0x03, 0x01, 0x22, 0x00,
      0xff, 0xd9, // EOI
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 600, height: 300 });
  });

  test('неизвестный формат → null', () => {
    expect(imageSize(Buffer.from('not an image at all'))).toBeNull();
    expect(imageSize(null)).toBeNull();
  });
});

describe('checkDownloadedPhoto / validatePhotoMessage (FR-B-040)', () => {
  const { validatePhotoMessage, checkDownloadedPhoto } = require('../helpers/validation');

  test('photo из Telegram: прошёл валидацию по сторонам и размеру', () => {
    const result = validatePhotoMessage({
      photo: [{ width: 800, height: 600, file_id: 'f1', file_size: 500 * 1024 }],
    });
    expect(result.ok).toBe(true);
    expect(result.meta.tgFileId).toBe('f1');
    expect(result.meta.mime).toBe('image/jpeg');
  });

  test('photo меньше 512 px по меньшей стороне — отказ', () => {
    const result = validatePhotoMessage({
      photo: [{ width: 1024, height: 400, file_id: 'f2', file_size: 500 * 1024 }],
    });
    expect(result).toEqual({ ok: false, reason: 'too_small' });
  });

  test('photo больше 10 МБ — отказ', () => {
    const result = validatePhotoMessage({
      photo: [{ width: 800, height: 800, file_id: 'f3', file_size: 11 * 1024 * 1024 }],
    });
    expect(result).toEqual({ ok: false, reason: 'size' });
  });

  test('document image/png принят, стороны проверяются после скачивания', () => {
    const result = validatePhotoMessage({
      document: { file_id: 'd1', mime_type: 'image/png', file_size: 500 * 1024 },
    });
    expect(result.ok).toBe(true);
    expect(result.meta.ext).toBe('png');
    expect(result.meta.width).toBeNull();
  });

  test('document не-изображение — отказ', () => {
    const result = validatePhotoMessage({
      document: { file_id: 'd2', mime_type: 'application/pdf', file_size: 500 * 1024 },
    });
    expect(result).toEqual({ ok: false, reason: 'not_a_photo' });
  });

  test('checkDownloadedPhoto: валидный шумный PNG 700x700 проходит', () => {
    const png = buildPng(700, 700, noise(7));
    const result = checkDownloadedPhoto(png);
    expect(result.ok).toBe(true);
    expect(result.meta).toEqual({ width: 700, height: 700 });
  });

  test('checkDownloadedPhoto: 300x300 — too_small', () => {
    const png = buildPng(300, 300, noise(9));
    expect(checkDownloadedPhoto(png)).toEqual({ ok: false, reason: 'too_small' });
  });
});
