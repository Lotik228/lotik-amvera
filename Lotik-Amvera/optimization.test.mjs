import assert from 'node:assert/strict';
import test from 'node:test';
import { apiBudgetStatus, budgetedFetch } from './api-budget.mjs';
import { createSearchLookup, createSearchWorker, listSavedSearches, parseSearchUrl, saveSearch } from './saved-searches.mjs';
import { openStore } from './store.mjs';
import { createWatchWorker } from './watch-worker.mjs';
import { addWatches, parseListingLink, setPlan } from './watches.mjs';

const url = id => 'https://www.avito.ru/moskva/telefony/phone_' + id;
const ad = (id, price) => ({ id, price, url: url(id), title: 'Телефон ' + id });
const search = { query: 'iPhone 15', city: 'moskva', maxPrice: 0 };

test('saves an Avito search link once per user without scheduling a lookup', async () => {
  const db = openStore(':memory:');
  const sourceUrl = 'https://www.avito.ru/moskva/telefony?q=iPhone%2015&localPriority=1&utm_source=test#results';
  const input = { sourceUrl, newEnabled: true, dropEnabled: true };
  saveSearch(db, 1, input, 200);
  saveSearch(db, 1, input, 201);
  assert.throws(() => saveSearch(db, 1, { ...input, sourceUrl: url('1234567890') }, 201), { status: 400 });
  assert.throws(() => saveSearch(db, 1, { ...input, sourceUrl: 'https://www.avito.ru.example.org/moskva/telefony' }, 201), { status: 400 });
  const [row] = listSavedSearches(db, 1);
  assert.equal(listSavedSearches(db, 1).length, 1);
  assert.equal(listSavedSearches(db, 2).length, 0);
  assert.equal(row.source_url, sourceUrl);
  assert.equal(row.new_enabled, 0);
  assert.equal(row.drop_enabled, 0);
  assert.equal(row.checked_at, null);
  await createSearchWorker(db, async () => assert.fail('Saved links must wait for a source'), () => 360)();
  assert.equal(listSavedSearches(db, 1)[0].checked_at, null);
  db.close();
});

test('accepts search links across categories and preserves the complete URL', () => {
  const db = openStore(':memory:');
  const links = [
    'https://www.avito.ru/moskva/avtomobili/toyota-ASgBAg?priceMax=1800000&s=104&f=ASgBA%2B%2f',
    'https://avito.ru/kazan/telefony/mobilnye_telefony?q=iPhone%2015&s=104&localPriority=1',
    'https://m.avito.ru/sankt-peterburg/kvartiry/prodam?priceMin=5000000&priceMax=8000000&params%5B1%5D=2',
    'https://www.avito.ru/ekaterinburg/odezhda_obuv_aksessuary/zhenskaya_odezhda?q=%D0%BF%D0%B0%D0%BB%D1%8C%D1%82%D0%BE&f=1&f=2#results',
    'https://www.avito.ru/rossiya/kollektsionirovanie',
    'https://www.avito.ru/?q=велосипед&s=104',
    'https://www.avito.ru/moskva/avtomobili?f=' + 'A'.repeat(2500),
  ];
  for (const sourceUrl of links) {
    assert.equal(parseSearchUrl(' ' + sourceUrl + ' '), sourceUrl);
    saveSearch(db, 1, { sourceUrl, newEnabled: true, dropEnabled: false }, 200);
  }
  assert.deepEqual(listSavedSearches(db, 1).map(row => row.source_url), [...links].reverse());
  db.close();
});

test('rejects unsafe URLs, listing details and non-catalog Avito pages as searches', () => {
  for (const value of [
    'javascript:alert(1)', 'http://avito.ru/moskva/avtomobili', '//avito.ru/moskva/avtomobili',
    'https://www.avito.ru.example.org/moskva/telefony', 'https://www.avito.ru@evil.example/moskva/telefony',
    'https://name@avito.ru/moskva/telefony', 'https://avito.ru:1234/moskva/telefony',
    'https://avito.ru/redirect?url=https://example.org', 'https://avito.ru/profile',
    'https://avito.ru/moskva/%2e%2e/profile', 'https://avito.ru/moskva%2ftelefony',
    'https://avito.ru/moskva//telefony', 'https://avito.ru/', url('1234567890'),
    'https://avito.ru/moskva/phone_%31%32%33%34%35%36', 'https://avito.ru/moskva/telefony?q=%GG',
  ]) assert.equal(parseSearchUrl(value), null, value);
});

test('shares a search across tariffs and delivers only enabled changes at each cadence', async () => {
  const db = openStore(':memory:');
  let time = 201;
  setPlan(db, 8, 'fast', time);
  saveSearch(db, 8, { ...search, newEnabled: false, dropEnabled: true }, time);
  saveSearch(db, 9, { ...search, query: '  IPHONE   15 ', newEnabled: true, dropEnabled: false }, time);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM saved_searches').get().n, 1);
  let rows = [ad('1234567890', 100)];
  let calls = 0;
  const run = createSearchWorker(db, async () => { calls++; return rows; }, () => time);
  time = 210;
  await run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_notifications').get().n, 0);
  rows = [ad('1234567890', 80), ad('1234567891', 50)];
  time = 240;
  await run();
  time = 270;
  await run();
  time = 360;
  await run();
  assert.equal(calls, 4);
  const alerts = db.prepare('SELECT user_id, kind, text FROM search_notifications ORDER BY id').all();
  assert.deepEqual(alerts.map(row => [row.user_id, row.kind]), [[8, 'drop'], [9, 'new']]);
  assert.match(alerts[0].text, /Было: 100 ₽\nСтало: 80 ₽\nСнижение: 20 ₽ \(20%\)/);
  assert.match(alerts[0].text, /https:\/\/www.avito.ru/);
  assert.equal(listSavedSearches(db, 9)[0].latest_drop, null);
  assert.equal(listSavedSearches(db, 8)[0].latest_new, null);
  assert.match(listSavedSearches(db, 8)[0].latest_drop, /20%/);
  const telegram = [];
  const deliver = createWatchWorker(db, null, async (_, msg) => telegram.push(msg), () => time);
  await deliver.deliverQueued();
  await deliver.deliverQueued();
  assert.equal(telegram.length, 2);
  db.close();
});

test('stops polling when both switches are off and rejects new active searches past the plan limit', async () => {
  const db = openStore(':memory:');
  saveSearch(db, 1, { ...search, newEnabled: true, dropEnabled: true }, 200);
  const id = listSavedSearches(db, 1)[0].id;
  assert.throws(() => saveSearch(db, 1, { ...search, query: 'iPhone 16', newEnabled: true, dropEnabled: false }, 200), { status: 409 });
  saveSearch(db, 1, { id, newEnabled: false, dropEnabled: false }, 201);
  let calls = 0;
  const worker = createSearchWorker(db, async () => { calls++; return []; }, () => 360);
  await worker();
  assert.equal(calls, 0);
  saveSearch(db, 1, { ...search, query: 'iPhone 16', newEnabled: false, dropEnabled: true }, 360);
  assert.equal(listSavedSearches(db, 1).length, 2);
  db.close();
});

test('does not notify the same price transition through both a search and a direct link', async () => {
  const db = openStore(':memory:');
  let time = 30;
  const id = '1234567890';
  setPlan(db, 1, 'fast', 0);
  saveSearch(db, 1, { ...search, newEnabled: true, dropEnabled: true }, 0);
  addWatches(db, 1, [parseListingLink(url(id))], 0);
  let price = 100;
  const searchWorker = createSearchWorker(db, async () => [ad(id, price)], () => time);
  const listingWorker = createWatchWorker(db, async () => ({ status: 'active', title: 'Телефон', price }), async () => {}, () => time);
  await searchWorker();
  await listingWorker.checkDue();
  price = 50;
  time = 60;
  await searchWorker();
  await listingWorker.checkDue();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_notifications').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM watch_notifications').get().n, 1); // Initial result only.
  db.close();
});

test('reserves shared credits atomically and backs off when the provider rate-limits', async () => {
  const db = openStore(':memory:');
  let time = Date.parse('2026-11-15T09:00:00Z');
  const config = { apiDailyCredits: 10, apiMonthlyCredits: 15 };
  const request = 'https://api.api.sh/avito/v1/search';
  let status = 200;
  let calls = 0;
  const fetchData = budgetedFetch(db, config, async () => {
    calls++;
    return Response.json({}, { status, headers: { 'retry-after': '5' } });
  }, () => time);
  const burst = await Promise.allSettled([fetchData(request), fetchData(request), fetchData(request)]);
  assert.deepEqual(burst.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(calls, 2);
  time += 86400000;
  status = 429;
  await fetchData(request);
  await assert.rejects(fetchData(request), /приостановлен/);
  time += 5000;
  await assert.rejects(fetchData(request), /Лимит/);
  assert.deepEqual(apiBudgetStatus(db, config, time), { today: 5, daily: 10, month: 15, monthly: 15 });
  assert.equal(calls, 3);
  db.close();
});

test('uses just the newest first page and asks API.SH for live data', async () => {
  let called;
  const lookup = createSearchLookup('test', async (request, options) => {
    called = request;
    assert.equal(options.headers['x-api-key'], 'test');
    return Response.json({ listings: [ad('1234567890', 100)], next_page: 2 });
  });
  assert.equal((await lookup({ query: 'iphone', city: 'all', max_price: 200 })).length, 1);
  assert.equal(called.searchParams.get('fresh'), '1');
  assert.equal(called.searchParams.get('page'), '1');
  assert.equal(called.searchParams.get('sort'), 'newest');
  assert.equal(called.searchParams.get('location'), 'rossiya');
  assert.equal(called.searchParams.get('price_max'), '200');
});
