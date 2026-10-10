// Определение размеров PNG/JPEG без внешних зависимостей (для валидации фото, FR-B-040).

const isPng = (buffer) =>
  buffer.length > 24 &&
  buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;

const isJpeg = (buffer) =>
  buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8;

const pngSize = (buffer) => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

const jpegSize = (buffer) => {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0..SOF15, кроме DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength <= 0) break;
    offset += 2 + segmentLength;
  }
  return null;
};

/**
 * @param {Buffer} buffer
 * @returns {{width:number, height:number}|null} null, если формат не распознан
 */
const imageSize = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return null;
  if (isPng(buffer)) return pngSize(buffer);
  if (isJpeg(buffer)) return jpegSize(buffer);
  return null;
};

module.exports = {
  imageSize,
};
