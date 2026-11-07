// Разбор одного multipart/form-data: текстовые поля и один файл.
// Нужен стенду, чтобы не тащить отдельную библиотеку в контейнер.
const parseMultipart = (buffer, contentType) => {
  const header = String(contentType || '');
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(header);
  if (!match) {
    throw Object.assign(new Error('multipart: нет boundary'), { code: 'validation' });
  }
  const boundary = (match[1] || match[2]).trim();
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const marker = Buffer.from(`--${boundary}`);
  const indexes = [];
  let from = 0;
  while (from < raw.length) {
    const at = raw.indexOf(marker, from);
    if (at < 0) break;
    indexes.push(at);
    from = at + marker.length;
  }

  const fields = {};
  let file = null;
  for (let i = 0; i < indexes.length - 1; i += 1) {
    let part = raw.slice(indexes[i] + marker.length, indexes[i + 1]);
    if (part.length >= 2 && part[0] === 13 && part[1] === 10) part = part.slice(2);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) continue;
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);
    const name = /name="([^"]+)"/.exec(headerText);
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(headerText);
    if (filename && filename[1]) {
      const mime = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      file = {
        filename: filename[1],
        mime: mime ? mime[1].trim() : 'application/octet-stream',
        buffer: body,
      };
    } else {
      fields[name[1]] = body.toString('utf8');
    }
  }
  return { fields, file };
};

module.exports = {
  parseMultipart,
};
