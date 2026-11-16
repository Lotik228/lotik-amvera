import { transaction } from './store.mjs';

export function normalizeFeed(value) {
  if (!Array.isArray(value?.listings) || value.listings.length > 10000) throw new Error('Invalid feed structure');
  const unique = new Map();
  for (const row of value.listings) {
    if (!row || typeof row !== 'object') throw new Error('Invalid listing');
    const { title, city, category, price, postedAt } = row;
    const url = new URL(row.url);
    const id = url.pathname.match(/_(\d{5,32})\/?$/)?.[1];
    const labels = [title, city, category];
    if (!id || url.protocol !== 'https:' || !['www.avito.ru', 'avito.ru', 'm.avito.ru'].includes(url.host)
      || url.username || url.password || labels.some(label => typeof label !== 'string' || !label.trim() || label.length > 200)
      || !Number.isSafeInteger(price) || price < 0 || price > 1e12
      || typeof postedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(postedAt)) {
      throw new Error('Invalid listing fields');
    }
    const date = Date.parse(postedAt);
    if (!Number.isFinite(date)) throw new Error('Invalid listing date');
    unique.set(id, { id, title: title.trim(), city: city.trim(), category: category.trim(), price, url: url.origin + url.pathname, date });
  }
  return [...unique.values()];
}

export function saveFeed(db, listings, now = Date.now()) {
  transaction(db, () => {
    db.exec('DELETE FROM listings');
    const insert = db.prepare('INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const item of listings) insert.run(item.id, item.title, item.city, item.category, item.price, item.url, item.date);
    db.prepare('INSERT OR REPLACE INTO feed_meta VALUES (1, ?)').run(now);
  });
}

export async function refreshFeed(config, db) {
  const headers = { Accept: 'application/json' };
  if (config.feedToken) headers.Authorization = 'Bearer ' + config.feedToken;
  const response = await fetch(config.feedUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Feed returned status ' + response.status);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 8_000_000) throw new Error('Feed exceeds 8 MB');
    chunks.push(chunk);
  }
  const items = normalizeFeed(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  saveFeed(db, items);
}

export function demoFeed() {
  const samples = [
    ['Apple iPhone 15 Pro, 256 ГБ', 'Москва', 'Электроника', 64900, 'telefony', 3],
    ['MacBook Air M2, 13″, 16/256 ГБ', 'Санкт-Петербург', 'Электроника', 72900, 'noutbuki', 9],
    ['Горный велосипед Trek Marlin 6', 'Москва', 'Спорт', 43500, 'velosipedy', 15],
    ['Кофемашина De’Longhi Magnifica', 'Казань', 'Для дома', 28900, 'bytovaya_tehnika', 22],
    ['Sony PlayStation 5 Slim, 1 ТБ', 'Москва', 'Электроника', 39900, 'igry_pristavki_i_programmy', 31],
    ['Кресло IKEA MARKUS', 'Санкт-Петербург', 'Для дома', 12900, 'mebel_i_interer', 44],
  ];
  return samples.map(([title, city, category, price, path, minutes], index) => ({
    id: String(index + 1), title, city, category, price, url: 'https://www.avito.ru/rossiya/' + path,
    date: Date.now() - minutes * 60_000,
  }));
}
