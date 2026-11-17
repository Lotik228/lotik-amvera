import { claimAlert, dropText, isDrop, priceLabel } from './alerts.mjs';
import { marketCities, normalizeSearch } from './market-search.mjs';
import { transaction } from './store.mjs';
import { nextSlot, parseListingLink, readTrackingName, userPlan } from './watches.mjs';

export function searchCriteria(input) {
  const query = typeof input?.query === 'string'
    ? input.query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU') : '';
  const city = input?.city || 'all';
  const max = input?.maxPrice == null || input.maxPrice === '' ? 0 : input.maxPrice;
  if (!query || query.length > 100 || typeof city !== 'string' || !Object.hasOwn(marketCities, city)
    || !Number.isSafeInteger(max) || max < 0 || max > 1e10) {
    throw Object.assign(new Error('Укажите запрос, город и корректную цену.'), { status: 400 });
  }
  return { query, city, max };
}

const isOn = row => Boolean(row?.new_enabled || row?.drop_enabled);
const cursor = (db, id) => db.prepare('SELECT COALESCE(MAX(id), 0) AS value FROM saved_search_events WHERE search_id = ?').get(id).value;

const nonCatalogPaths = new Set([
  'account', 'api', 'auth', 'delivery', 'favorites', 'help', 'i', 'items', 'legal',
  'login', 'messenger', 'out', 'payment', 'profile', 'redirect', 'registration',
  'settings', 'share', 'support', 'users', 'web',
]);

export function parseSearchUrl(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate.length > 8192 || /[\s\\\p{Cc}]|%(?![\da-f]{2})/iu.test(candidate)) return null;

  const match = /^https:\/\/(?:www\.|m\.)?avito\.ru(\/[^?#]*)?(?=[?#]|$)/i.exec(candidate);
  if (!match) return null;
  let segments;
  try {
    segments = (match[1] ?? '').replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.some(segment => !/^[\p{L}\p{N}_-]+$/u.test(segment))
    || nonCatalogPaths.has(segments[0]?.toLowerCase())
    || parseListingLink('https://www.avito.ru/' + segments.join('/'))) return null;
  if (!segments.length && !new URL(candidate).searchParams.get('q')?.trim()) return null;
  return candidate;
}

export function resolveWatchLink(input) {
  const searchUrl = parseSearchUrl(input);
  if (searchUrl) return { kind: 'search', url: searchUrl };
  const value = typeof input === 'string' ? input.trim() : '';
  const listing = value.length <= 8192 && /^(?:https:\/\/)?(?:www\.|m\.)?avito\.ru\//i.test(value)
    && !/[\s\\\p{Cc}]|%(?![\da-f]{2})/iu.test(value) ? parseListingLink(value) : null;
  if (listing) {
    const path = new URL(listing.url).pathname;
    let first = '';
    try { first = decodeURIComponent(path.split('/')[1]).toLowerCase(); } catch { /* Invalid path encoding. */ }
    if (first && (!nonCatalogPaths.has(first) || /^\/(?:i|items)\/\d+$/.test(path))) {
      return { kind: 'listing', url: listing.url, id: listing.id };
    }
  }
  throw Object.assign(new Error('Вставьте HTTPS-ссылку на поиск или объявление Авито.'), { status: 400 });
}

export function listSavedSearches(db, userId) {
  return db.prepare(`
    SELECT sub.id, s.query, s.source_url, s.city, s.max_price, s.checked_at, sub.due_at, sub.new_enabled, sub.drop_enabled, sub.tracking_name,
      (SELECT text FROM saved_search_activity WHERE subscription_id = sub.id AND kind = 'new') AS latest_new,
      (SELECT text FROM saved_search_activity WHERE subscription_id = sub.id AND kind = 'drop') AS latest_drop
    FROM saved_search_users AS sub JOIN saved_searches AS s ON s.id = sub.search_id
    WHERE sub.user_id = ? ORDER BY sub.id DESC
  `).all(userId);
}

export function linkSourceState(db, enabled) {
  if (!enabled) return 'off';
  return db.prepare('SELECT paused_reason FROM parser_state WHERE id = 1').get().paused_reason ? 'paused' : 'ready';
}

export function saveSearch(db, userId, input, now, { allowSaveOnly = false } = {}) {
  if (typeof input?.newEnabled !== 'boolean' || typeof input?.dropEnabled !== 'boolean') {
    throw Object.assign(new Error('Укажите настройки уведомлений.'), { status: 400 });
  }
  const name = readTrackingName(input.name);
  return transaction(db, () => {
    let existing;
    let searchId;
    let sourceUrl = null;
    if (input.id != null) {
      if (!Number.isSafeInteger(input.id) || input.id < 1) throw Object.assign(new Error('Некорректный поиск.'), { status: 400 });
      existing = db.prepare('SELECT * FROM saved_search_users WHERE id = ? AND user_id = ?').get(input.id, userId);
      if (!existing) throw Object.assign(new Error('Поиск не найден.'), { status: 404 });
      searchId = existing.search_id;
      sourceUrl = db.prepare('SELECT source_url FROM saved_searches WHERE id = ?').get(searchId).source_url;
    } else if (input.sourceUrl != null) {
      const url = parseSearchUrl(input.sourceUrl);
      if (!url) throw Object.assign(new Error('Вставьте HTTPS-ссылку на поиск или категорию Авито.'), { status: 400 });
      sourceUrl = url;
      // The capitalized prefix cannot collide with normalized, lowercase text searches.
      const key = 'Avito URL ' + url;
      db.prepare("INSERT OR IGNORE INTO saved_searches(query, city, max_price, source_url) VALUES (?, 'all', 0, ?)").run(key, url);
      searchId = db.prepare("SELECT id FROM saved_searches WHERE query = ? AND city = 'all' AND max_price = 0").get(key).id;
      existing = db.prepare('SELECT * FROM saved_search_users WHERE search_id = ? AND user_id = ?').get(searchId, userId);
      if (existing) return { sourceUrl, notificationsEnabled: isOn(existing), alreadySaved: true };
    } else {
      const { query, city, max } = searchCriteria(input);
      db.prepare('INSERT OR IGNORE INTO saved_searches(query, city, max_price) VALUES (?, ?, ?)').run(query, city, max);
      searchId = db.prepare('SELECT id FROM saved_searches WHERE query = ? AND city = ? AND max_price = ?').get(query, city, max).id;
      existing = db.prepare('SELECT * FROM saved_search_users WHERE search_id = ? AND user_id = ?').get(searchId, userId);
    }
    let { newEnabled, dropEnabled } = input;
    const { seconds, searchLimit } = userPlan(db, userId);
    const counts = db.prepare(`
      SELECT COUNT(*) AS total, SUM(new_enabled OR drop_enabled) AS active FROM saved_search_users WHERE user_id = ?
    `).get(userId);
    const limitReached = !isOn(existing) && (newEnabled || dropEnabled) && counts.active >= searchLimit;
    if (limitReached) {
      if (!allowSaveOnly || existing) {
        throw Object.assign(new Error('По тарифу доступно поисков с уведомлениями: ' + searchLimit
          + '. Выключите уведомления у другого поиска.'), { status: 409 });
      }
      newEnabled = false;
      dropEnabled = false;
    }
    if (!existing && counts.total >= 30) throw Object.assign(new Error('Удалите один из сохранённых поисков.'), { status: 409 });
    const active = db.prepare('SELECT 1 FROM saved_search_users WHERE search_id = ? AND user_id <> 0 AND (new_enabled OR drop_enabled) LIMIT 1');
    if (!isOn(existing) && (newEnabled || dropEnabled) && !active.get(searchId)) {
      db.prepare('UPDATE saved_searches SET checked_at = NULL WHERE id = ?').run(searchId);
    }
    const last = cursor(db, searchId);
    const newCursor = existing?.new_enabled && newEnabled ? existing.new_cursor : last;
    const dropCursor = existing?.drop_enabled && dropEnabled ? existing.drop_cursor : last;
    db.prepare(`
      INSERT INTO saved_search_users (search_id, user_id, new_enabled, drop_enabled, new_cursor, drop_cursor, due_at, tracking_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(search_id, user_id) DO UPDATE SET
        new_enabled = excluded.new_enabled, drop_enabled = excluded.drop_enabled, new_cursor = excluded.new_cursor,
        drop_cursor = excluded.drop_cursor, due_at = excluded.due_at,
        tracking_name = COALESCE(excluded.tracking_name, saved_search_users.tracking_name)
    `).run(searchId, userId, Number(newEnabled), Number(dropEnabled), newCursor, dropCursor,
      isOn(existing) ? existing.due_at : nextSlot(now, seconds), name);
    const cancel = db.prepare('DELETE FROM search_notifications WHERE subscription_id = ? AND kind = ?');
    if (existing && !newEnabled) cancel.run(existing.id, 'new');
    if (existing && !dropEnabled) cancel.run(existing.id, 'drop');
    return { sourceUrl, notificationsEnabled: newEnabled || dropEnabled, limitReached };
  });
}

export function deleteSearch(db, userId, id) {
  return transaction(db, () => {
    const deleted = db.prepare('DELETE FROM saved_search_users WHERE id = ? AND user_id = ? RETURNING search_id').get(id, userId);
    if (!deleted) return false;
    db.prepare('DELETE FROM saved_searches WHERE id = ? AND NOT EXISTS (SELECT 1 FROM saved_search_users WHERE search_id = ?)').run(deleted.search_id, deleted.search_id);
    return true;
  });
}

export function createSearchLookup(key, fetchData = fetch) {
  return async search => {
    const url = new URL('https://api.api.sh/avito/v1/search');
    for (const [name, value] of Object.entries({
      q: search.query, location: search.city === 'all' ? 'rossiya' : search.city,
      sort: 'newest', page: '1', fresh: '1', raw: '0',
    })) url.searchParams.set(name, value);
    if (search.max_price) url.searchParams.set('price_max', search.max_price);
    const response = await fetchData(url, {
      headers: { Accept: 'application/json', 'x-api-key': key }, redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error('Avito search returned ' + response.status);
    return normalizeSearch(await response.json()).rows;
  };
}

function recordResults(db, search, rows, now) {
  const seen = db.prepare('SELECT price FROM saved_search_seen WHERE search_id = ? AND listing_id = ?');
  const save = db.prepare(`
    INSERT INTO saved_search_seen VALUES (?, ?, ?) ON CONFLICT(search_id, listing_id) DO UPDATE SET price = excluded.price
  `);
  const event = db.prepare('INSERT INTO saved_search_events (search_id, kind, listing_id, previous_price, price, text) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    const previous = seen.get(search.id, row.id);
    if (search.checked_at != null) {
      if (!previous) event.run(search.id, 'new', row.id, null, row.price,
        'Новое объявление\n' + row.title + '\n' + priceLabel(row.price) + '\n' + row.url);
      else if (isDrop(previous.price, row.price)) event.run(search.id, 'drop', row.id, previous.price, row.price,
        dropText(row.title, row.url, previous.price, row.price));
    }
    save.run(search.id, row.id, row.price ?? previous?.price ?? null);
  }
  db.prepare('UPDATE saved_searches SET checked_at = ? WHERE id = ?').run(now, search.id);
}

export function applySearchResults(db, searchId, rows, now) {
  const current = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(searchId);
  if (!current) return;
  const due = db.prepare(`
    SELECT * FROM saved_search_users WHERE search_id = ? AND user_id <> 0 AND due_at <= ? AND (new_enabled OR drop_enabled)
  `).all(searchId, now);
  if (!due.length) return;
  if (rows) recordResults(db, current, rows, now);
  const list = db.prepare(`
    SELECT * FROM saved_search_events WHERE search_id = ? AND ((kind = 'new' AND id > ? AND ? = 1)
      OR (kind = 'drop' AND id > ? AND ? = 1)) ORDER BY id
  `);
  const last = cursor(db, searchId);
  const advance = db.prepare('UPDATE saved_search_users SET due_at = ?, new_cursor = MAX(new_cursor, ?), drop_cursor = MAX(drop_cursor, ?) WHERE id = ?');
  const queue = db.prepare('INSERT INTO search_notifications (subscription_id, kind, user_id, text, retry_at) VALUES (?, ?, ?, ?, ?)');
  const activity = db.prepare('INSERT OR REPLACE INTO saved_search_activity VALUES (?, ?, ?)');
  for (const sub of due) {
    for (const event of list.all(searchId, sub.new_cursor, sub.new_enabled, sub.drop_cursor, sub.drop_enabled)) {
      activity.run(sub.id, event.kind, event.text);
      if (sub.user_id > 0 && claimAlert(db, sub.user_id, event.kind, event.listing_id, event.previous_price, event.price, now)) {
        queue.run(sub.id, event.kind, sub.user_id, event.text, now);
      }
    }
    advance.run(nextSlot(now, userPlan(db, sub.user_id).seconds), last, last, sub.id);
  }
  db.prepare(`
    DELETE FROM saved_search_events WHERE search_id = ? AND id <= COALESCE((
      SELECT MIN(MIN(CASE WHEN new_enabled THEN new_cursor ELSE ? END, CASE WHEN drop_enabled THEN drop_cursor ELSE ? END))
      FROM saved_search_users WHERE search_id = ? AND user_id <> 0 AND (new_enabled OR drop_enabled)
    ), ?)
  `).run(searchId, last, last, searchId, last);
  db.prepare('DELETE FROM recent_alerts WHERE notified_at < ?').run(now - 86400);
}

export function createSearchWorker(db, lookup, now = () => Math.floor(Date.now() / 1000)) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const searches = db.prepare(`
        SELECT s.* FROM saved_searches s JOIN saved_search_users sub ON sub.search_id = s.id
        WHERE s.source_url IS NULL AND sub.user_id <> 0 AND sub.due_at <= ? AND (sub.new_enabled OR sub.drop_enabled)
        GROUP BY s.id ORDER BY MIN(sub.due_at), s.id LIMIT 24
      `).all(now());
      for (let i = 0; i < searches.length; i += 6) {
        await Promise.all(searches.slice(i, i + 6).map(async search => {
          let rows;
          try { rows = await lookup(search); } catch (error) { console.error('Проверка поиска отложена: ' + error.message); }
          transaction(db, () => applySearchResults(db, search.id, rows, now()));
        }));
      }
    } finally {
      running = false;
    }
  };
}
