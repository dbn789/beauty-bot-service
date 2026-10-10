// Валидация фото клиента (ТЗ FR-B-040): JPEG/PNG, 0.1–10 МБ, меньшая сторона ≥ 512 px.
const { imageSize } = require('./imageSize');

const MIN_BYTES = 100 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_SIDE = 512;

const isPhotoPayload = (message) => Boolean(message.photo) || isImageDocument(message);

const isImageDocument = (message) =>
  Boolean(
    message.document &&
    ['image/jpeg', 'image/png'].includes(message.document.mime_type)
  );

const documentExt = (mime) => (mime === 'image/png' ? 'png' : 'jpg');

/**
 * Проверяет полезную нагрузку сообщения с фото (photo[] или document image/*).
 * Возвращает { ok: true, meta } либо { ok: false, reason }.
 */
const validatePhotoMessage = (message) => {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    const bytes = largest.file_size || 0;
    if (bytes && (bytes < MIN_BYTES || bytes > MAX_BYTES)) {
      return { ok: false, reason: 'size' };
    }
    if (Math.min(largest.width, largest.height) < MIN_SIDE) {
      return { ok: false, reason: 'too_small' };
    }
    return {
      ok: true,
      meta: {
        tgFileId: largest.file_id,
        mime: 'image/jpeg',
        ext: 'jpg',
        bytes,
        width: largest.width,
        height: largest.height,
      },
    };
  }

  if (isImageDocument(message)) {
    const doc = message.document;
    if (!doc.file_size || doc.file_size < MIN_BYTES || doc.file_size > MAX_BYTES) {
      return { ok: false, reason: 'size' };
    }
    // Стороны документа узнаем после скачивания (checkDownloadedPhoto)
    return {
      ok: true,
      meta: {
        tgFileId: doc.file_id,
        mime: doc.mime_type,
        ext: documentExt(doc.mime_type),
        bytes: doc.file_size,
        width: null,
        height: null,
      },
    };
  }

  return { ok: false, reason: 'not_a_photo' };
};

/**
 * Повторная проверка скачанного буфера (для document, где стороны неизвестны из Telegram).
 */
const checkDownloadedPhoto = (buffer) => {
  if (buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) {
    return { ok: false, reason: 'size' };
  }
  const size = imageSize(buffer);
  if (!size) return { ok: false, reason: 'not_a_photo' };
  if (Math.min(size.width, size.height) < MIN_SIDE) {
    return { ok: false, reason: 'too_small' };
  }
  return { ok: true, meta: size };
};

module.exports = {
  validatePhotoMessage,
  checkDownloadedPhoto,
  isPhotoPayload,
};
