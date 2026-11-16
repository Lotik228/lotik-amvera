import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketSearch, normalizeSearch } from './market-search.mjs';
import { openStore } from './store.mjs';

const listings = Array.from({ length: 5 }, (_, index) => ({
  id: 1234567890 + index,
  url: 'https://www.avito.ru/kazan/telefony/phone_' + (1234567890 + index),
  title: 'iPhone ' + (12 + index), price: 35000 + 1000 * index,
  category: { name: 'Телефоны' }, published: '2026-11-15T10:00:00Z',
}));

test('sends the search term and selected city to the marketplace provider', async () => {
  const db = openStore(':memory:');
  const calls = [];
  const search = createMarketSearch('fixture-token', async (url, options) => {
    calls.push({ url, headers: options.headers });
    return Response.json({ listings, total: 12, next_page: 2 });
  });
  const params = new URLSearchParams({ q: 'iPhone', city: 'kazan', max: '50000', sort: 'price' });
  const basic = await search(db, 1, false, params);
  assert.equal(calls[0].url.searchParams.get('q'), 'iPhone');
  assert.equal(calls[0].url.searchParams.get('location'), 'kazan');
  assert.equal(calls[0].url.searchParams.get('price_max'), '50000');
  assert.equal(calls[0].url.searchParams.get('sort'), 'price_asc');
  assert.equal(calls[0].headers['x-api-key'], 'fixture-token');
  assert.equal(basic.rows.length, 3);
  assert.equal(basic.total, 12);
  assert.equal(basic.nextPage, null);
  assert.equal(basic.rows[0].city, 'Казань');
  db.prepare('INSERT INTO favorites VALUES (?, ?)').run(1, basic.rows[0].id);
  const pro = await search(db, 1, true, params);
  assert.equal(calls.length, 1);
  assert.equal(pro.rows.length, 5);
  assert.equal(pro.nextPage, 2);
  assert.equal(pro.rows[0].saved, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM market_listings').get().total, 5);
  db.close();
});

test('keeps direct card URLs and rejects mismatched or third-party links', () => {
  const result = normalizeSearch({ listings: [
    { ...listings[0], url: listings[0].url + '?utm_source=test' },
    { ...listings[0], url: 'https://evil.example/kazan/phone_1234567890' },
    { ...listings[0], id: 9000000 },
  ] });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].url, listings[0].url);
});
