import { parseListingLink } from './watches.mjs';
import { transaction } from './store.mjs';

export const marketCities = Object.freeze({
  all: 'Вся Россия',
  moskva: 'Москва',
  'sankt-peterburg': 'Санкт-Петербург',
  ekaterinburg: 'Екатеринбург',
  kazan: 'Казань',
  krasnodar: 'Краснодар',
  'nizhniy_novgorod': 'Нижний Новгород',
  novosibirsk: 'Новосибирск',
  'rostov-na-donu': 'Ростов-на-Дону',
  samara: 'Самара',
  ufa: 'Уфа',
  chelyabinsk: 'Челябинск',
});

function text(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 250) : fallback;
}

export function normalizeSearch(data) {
  if (!Array.isArray(data?.listings)) throw new Error('Unexpected Avito search response');
  const rows = new Map();
  for (const ad of data.listings.slice(0, 100)) {
    const link = parseListingLink(ad?.url);
    if (!link || link.id !== String(ad.id) || !text(ad.title)) continue;
    const slug = new URL(link.url).pathname.split('/')[1];
    const published = Date.parse(ad.published);
    const price = Number.isSafeInteger(ad.price) && ad.price >= 0 && ad.price <= 1e12 ? ad.price : null;
    rows.set(link.id, {
      id: link.id, url: link.url, title: text(ad.title), city: text(ad.location?.name ?? ad.location, marketCities[slug] ?? ''),
      category: text(ad.category?.name, ''), price, posted_at: Number.isFinite(published) ? published : null,
    });
  }
  return {
    rows: [...rows.values()],
    total: Number.isSafeInteger(data.total) && data.total >= rows.size ? data.total : rows.size,
    nextPage: Number.isInteger(data.next_page) && data.next_page > 0 && data.next_page <= 100 ? data.next_page : null,
  };
}

export function createMarketSearch(key, fetchData = fetch) {
  const cache = new Map();
  return async (db, userId, hasPro, params) => {
    const q = params.get('q')?.trim().slice(0, 100);
    if (!q) return { rows: [], total: 0, nextPage: null, limited: false };
    const city = params.get('city');
    const location = city && Object.hasOwn(marketCities, city) && city !== 'all' ? city : 'rossiya';
    const page = hasPro ? Math.max(1, Math.min(100, parseInt(params.get('page'), 10) || 1)) : 1;
    const max = params.get('max');
    const sortName = params.get('sort');
    const sort = sortName === 'price' ? 'price_asc' : sortName === 'new' ? 'newest' : 'default';
    const url = new URL('https://api.api.sh/avito/v1/search');
    for (const [name, value] of Object.entries({ q, location, page, sort })) url.searchParams.set(name, value);
    if (/^\d{1,10}$/.test(max ?? '')) url.searchParams.set('price_max', max);
    const requestKey = url.href;
    const now = Date.now();
    let cached = cache.get(requestKey);
    if (!cached || cached.expiresAt <= now) {
      if (cache.size >= 150) cache.delete(cache.keys().next().value);
      const pending = (async () => {
        const response = await fetchData(url, {
          headers: { 'x-api-key': key, Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        if (response.status === 404) return { rows: [], total: 0, nextPage: null };
        if (!response.ok) throw new Error('Avito search returned ' + response.status);
        return normalizeSearch(await response.json());
      })();
      cached = { pending, expiresAt: now + 60000 };
      cache.set(requestKey, cached);
      void pending.catch(() => {
        if (cache.get(requestKey) === cached) cache.delete(requestKey);
      });
    }
    const result = await cached.pending;
    const visible = hasPro ? result.rows : result.rows.slice(0, 3);
    transaction(db, () => {
      db.prepare(`
        DELETE FROM market_listings WHERE updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM favorites WHERE favorites.ad_id = market_listings.id)
      `).run(now - 86400000);
      const save = db.prepare(`
        INSERT OR REPLACE INTO market_listings (id, title, city, category, price, url, posted_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of visible) save.run(row.id, row.title, row.city, row.category, row.price, row.url, row.posted_at, now);
    });
    const saved = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND ad_id = ?');
    return {
      rows: visible.map(row => ({ ...row, saved: Boolean(saved.get(userId, row.id)) })),
      total: result.total, nextPage: hasPro ? result.nextPage : null, limited: !hasPro && result.total > 3,
    };
  };
}
