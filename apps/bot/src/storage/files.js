// Файловое хранилище изображений (ТЗ Д3, FR-I-070): DATA_DIR/photos/{sources,results}.
// Исходники: photos/sources/<userId>/<uuid>.<ext> — один актуальный на пользователя.
// Результаты: photos/results/<requestId>/v<N>.png
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const createFileStorage = ({ dataDir, logger }) => {
  const root = path.resolve(dataDir, 'photos');
  const sourcesDir = path.join(root, 'sources');
  const resultsDir = path.join(root, 'results');

  const init = async () => {
    await fsp.mkdir(sourcesDir, { recursive: true });
    await fsp.mkdir(resultsDir, { recursive: true });
  };

  const safePath = (relative) => {
    const full = path.resolve(root, relative);
    if (!full.startsWith(root + path.sep)) {
      throw new Error(`storage: path traversal blocked: ${relative}`);
    }
    return full;
  };

  const saveSource = async ({ userId, ext, buffer }) => {
    const userDir = path.join(sourcesDir, String(userId));
    await fsp.mkdir(userDir, { recursive: true });
    // один актуальный исходник на пользователя: старые чистим
    const previous = await fsp.readdir(userDir).catch(() => []);
    const name = `${crypto.randomUUID()}.${ext || 'jpg'}`;
    await fsp.writeFile(path.join(userDir, name), buffer);
    for (const old of previous) {
      await fsp.unlink(path.join(userDir, old)).catch(() => {});
    }
    return path.relative(root, path.join(userDir, name));
  };

  const saveVariant = async ({ requestId, index, buffer }) => {
    const dir = path.join(resultsDir, String(requestId));
    await fsp.mkdir(dir, { recursive: true });
    const name = `v${index + 1}.png`;
    await fsp.writeFile(path.join(dir, name), buffer);
    return path.relative(root, path.join(dir, name));
  };

  const read = async (relative) => fsp.readFile(safePath(relative));

  const exists = async (relative) => {
    try {
      await fsp.access(safePath(relative));
      return true;
    } catch {
      return false;
    }
  };

  const deleteFiles = async (relatives) => {
    let deleted = 0;
    for (const relative of relatives || []) {
      if (!relative) continue;
      try {
        await fsp.unlink(safePath(relative));
        deleted += 1;
      } catch (error) {
        logger.debug({ relative, err: error.message }, 'storage: delete skipped');
      }
    }
    return deleted;
  };

  const deleteRequestArtifacts = async ({ requestId, paths }) => {
    const deleted = await deleteFiles(paths);
    await fsp.rm(path.join(resultsDir, String(requestId)), { recursive: true, force: true }).catch(() => {});
    return deleted;
  };

  const stat = () => ({
    root,
    writable: fs.constants.W_OK,
  });

  return {
    init,
    saveSource,
    saveVariant,
    read,
    exists,
    deleteFiles,
    deleteRequestArtifacts,
    stat,
  };
};

module.exports = {
  createFileStorage,
};
