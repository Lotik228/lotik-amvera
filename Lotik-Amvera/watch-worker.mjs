import { finishCheck } from './watches.mjs';

const secondsNow = () => Math.floor(Date.now() / 1000);
export const linkOptions = { is_disabled: true };
export const hasLookup = config => Boolean(config.watchUrl || config.watchApiKey);

export function createLookup(config, fetchData = fetch) {
  if (!config.watchUrl) {
    return async watch => {
      const url = new URL('https://api.api.sh/avito/v1/listing');
      url.searchParams.set('id', watch.listing_id);
      url.searchParams.set('fresh', '1');
      url.searchParams.set('raw', '0');
      const response = await fetchData(url, {
        headers: { Accept: 'application/json', 'x-api-key': config.watchApiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 404) return { status: 'unavailable', title: null, price: null };
      if (!response.ok) throw new Error('Avito listing returned ' + response.status);
      const item = await response.json();
      if (typeof item?.closed !== 'boolean') throw new Error('Unexpected Avito listing status');
      return validateSnapshot({
        id: String(item.id),
        status: item.closed ? 'unavailable' : 'active',
        title: typeof item.title === 'string' ? item.title.slice(0, 180) : item.title,
        price: item.closed ? null : item.price,
      }, watch.listing_id);
    };
  }

  return async watch => {
    const url = new URL(config.watchUrl);
    url.searchParams.set('id', watch.listing_id);
    url.searchParams.set('url', watch.url);
    const headers = { Accept: 'application/json' };
    if (config.watchToken) headers.Authorization = 'Bearer ' + config.watchToken;
    const response = await fetchData(url, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Lookup returned ' + response.status);
    return validateSnapshot(await response.json(), watch.listing_id);
  };
}

export function validateSnapshot(input, id) {
  if (typeof input?.id !== 'string' || input.id !== id || !['active', 'unavailable'].includes(input.status)
    || (input.title != null && (typeof input.title !== 'string' || input.title.length > 180))
    || (input.price != null && (!Number.isSafeInteger(input.price) || input.price < 0 || input.price > 1e12))) {
    throw new Error('Unexpected listing response');
  }
  return {
    status: input.status,
    title: input.title?.trim() || null,
    price: input.status === 'active' ? (input.price ?? null) : null,
  };
}

export function createWatchWorker(db, lookup, telegram, now = secondsNow) {
  let checking = false;
  let delivering = false;
  const cache = new Map();

  async function checkDue() {
    if (checking || !lookup) return;
    checking = true;
    try {
      const due = db.prepare('SELECT * FROM watches WHERE due_at <= ? ORDER BY due_at, id LIMIT 40').all(now());
      const groups = new Map();
      const failures = [];
      for (const watch of due) {
        if (!groups.has(watch.listing_id)) groups.set(watch.listing_id, []);
        groups.get(watch.listing_id).push(watch);
      }
      const batches = [...groups.values()];
      for (let offset = 0; offset < batches.length; offset += 8) {
        await Promise.all(batches.slice(offset, offset + 8).map(async watches => {
          let snapshot;
          const id = watches[0].listing_id;
          const recent = cache.get(id);
          try {
            if (recent && recent.at + 5 > now()) snapshot = recent.snapshot;
            else {
              snapshot = await lookup(watches[0]);
              if (cache.size >= 1000) cache.delete(cache.keys().next().value);
              cache.set(id, { snapshot, at: now() });
            }
          } catch (error) { failures.push(error); }
          const time = now();
          for (const watch of watches) finishCheck(db, watch, snapshot, time);
        }));
      }
      if (failures.length) console.error('Источник отслеживания недоступен для ' + failures.length + ' объявлений. Проверки будут повторены.');
    } finally {
      checking = false;
    }
  }

  async function deliverQueued() {
    if (delivering) return;
    delivering = true;
    try {
      const due = db.prepare(`
        WITH queued AS (
          SELECT id, user_id, text, retry_at, attempts, 0 AS source FROM watch_notifications
          UNION ALL
          SELECT id, user_id, text, retry_at, attempts, 1 AS source FROM search_notifications
        ), per_chat AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY retry_at, source, id) AS slot
          FROM queued WHERE retry_at <= ?
        )
        SELECT * FROM per_chat WHERE slot = 1
        ORDER BY retry_at, id LIMIT 20
      `).all(now());
      const queues = ['watch_notifications', 'search_notifications'].map(table => ({
        remove: db.prepare('DELETE FROM ' + table + ' WHERE id = ?'),
        exists: db.prepare('SELECT 1 FROM ' + table + ' WHERE id = ?'),
        retry: db.prepare('UPDATE ' + table + ' SET retry_at = ?, attempts = attempts + 1 WHERE id = ?'),
      }));
      await Promise.all(due.map(async notice => {
        const { remove, exists, retry } = queues[notice.source];
        if (!exists.get(notice.id)) return;
        try {
          await telegram('sendMessage', { chat_id: notice.user_id, text: notice.text, link_preview_options: linkOptions });
          remove.run(notice.id);
        } catch (error) {
          if ([400, 403].includes(error.telegramCode)) remove.run(notice.id);
          else {
            const delay = Math.max(error.retryAfter ?? 0, Math.min(900, 5 * 2 ** Math.min(8, notice.attempts)));
            retry.run(now() + delay, notice.id);
          }
        }
      }));
    } finally {
      delivering = false;
    }
  }

  return { checkDue, deliverQueued };
}

export function startWatchWorker(db, lookup, telegram, checkSearches) {
  const { checkDue, deliverQueued } = createWatchWorker(db, lookup, telegram);
  async function tick() {
    await Promise.all([checkDue(), telegram && deliverQueued(), checkSearches?.()]);
  }
  const poll = () => void tick().catch(() => console.error('Ошибка фонового отслеживания. Следующая попытка через секунду.'));
  poll();
  return setInterval(poll, 1000).unref();
}

export async function demoLookup(watch) {
  return { status: 'active', title: 'Объявление № ' + watch.listing_id, price: watch.checked_at ? 62900 : 64900 };
}
