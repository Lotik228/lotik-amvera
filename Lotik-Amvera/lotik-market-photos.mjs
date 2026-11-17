import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const marketPhotoId = /^[a-f0-9]{32}$/;
const maxBytes = 6 * 1024 * 1024;
const script = fileURLToPath(new URL('./lotik-market-image.py', import.meta.url));

function photoError(message, status) {
  return Object.assign(new Error(message), { status });
}

function encode(input, python) {
  return new Promise((resolve, reject) => {
    const process = spawn(python, [script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => process.kill(), 8000);
    process.on('error', () => reject(photoError('Обработка фотографий временно недоступна.', 503)));
    process.stdin.on('error', () => {});
    process.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) process.kill();
      else chunks.push(chunk);
    });
    process.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && bytes > 0 && bytes <= 2 * 1024 * 1024) resolve(Buffer.concat(chunks));
      else reject(photoError('Загрузите обычное фото JPEG, PNG или WebP размером до 6 МБ.', 400));
    });
    process.stdin.end(input);
  });
}

export function createMarketPhotos(db, dataDir, python = process.env.MARKET_IMAGE_PYTHON || 'python3') {
  const dir = join(dataDir, 'lotik-market-photos');
  const photoPath = id => join(dir, id + '.jpg');
  let processing = 0;
  let lastCleanup = 0;

  async function cleanup(now) {
    if (lastCleanup >= now - 3600) return;
    lastCleanup = now;
    db.prepare('DELETE FROM lotik_market_photos WHERE ad_id IS NULL AND created_at < ?').run(now - 86400);
    for (const name of await readdir(dir)) {
      const id = name.slice(0, -4);
      if (!name.endsWith('.jpg') || !marketPhotoId.test(id)) continue;
      if (db.prepare('SELECT 1 FROM lotik_market_photos WHERE id = ?').get(id)) continue;
      const path = photoPath(id);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < (now - 3600) * 1000) await unlink(path).catch(() => {});
    }
  }

  return {
    async upload(req, owner, now) {
      if (processing >= 2) throw photoError('Обработка фото занята. Попробуйте ещё раз.', 429);
      if (Number(req.headers['content-length']) > maxBytes) throw photoError('Фото должно быть до 6 МБ.', 413);
      processing++;
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.resume();
            throw photoError('Фото должно быть до 6 МБ.', 413);
          }
          chunks.push(chunk);
        }
        const jpg = await encode(Buffer.concat(chunks), python);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await cleanup(now);
        const id = randomUUID().replaceAll('-', '');
        const path = photoPath(id);
        await writeFile(path, jpg, { flag: 'wx', mode: 0o600 });
        try {
          db.prepare('INSERT INTO lotik_market_photos (id, owner_id, created_at) VALUES (?, ?, ?)').run(id, owner, now);
        } catch (error) {
          await unlink(path).catch(() => {});
          throw error;
        }
        return { id };
      } finally {
        processing--;
      }
    },
    read(id) {
      if (!marketPhotoId.test(id)) throw photoError('Фото не найдено.', 404);
      return readFile(photoPath(id)).catch(error => {
        if (error.code === 'ENOENT') throw photoError('Фото не найдено.', 404);
        throw error;
      });
    },
    async remove(ids) {
      await Promise.all(ids.map(id => unlink(photoPath(id)).catch(() => {})));
    },
  };
}
