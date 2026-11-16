import assert from 'node:assert/strict';
import test from 'node:test';
import { handleBotUpdate } from './bot.mjs';
import { openStore } from './store.mjs';
import { createLookup, createWatchWorker, hasLookup, validateSnapshot } from './watch-worker.mjs';
import { addWatches, extractLinks, parseListingLink, removeWatch, setPlan } from './watches.mjs';

const link = 'https://www.avito.ru/moskva/telefony/phone_1234567890';
const item = parseListingLink(link);
const active = price => ({ status: 'active', price, title: 'Смартфон' });

test('accepts direct Avito ad links and deduplicates canonical ids', () => {
  const message = {
    text: 'Смотри (' + link + '?utm_source=share), https://evil.test/avito.ru/phone_7654321 и avito.ru/rossiya?q=телефон',
    entities: [
      { type: 'text_link', url: 'https://avito.ru/i/1234567890' },
      { type: 'text_link', url: 'https://m.avito.ru/items/34567890' },
    ],
  };
  assert.deepEqual(extractLinks(message).map(item => item.id), ['1234567890', '34567890']);
  assert.equal(parseListingLink('https://avito.ru@evil.test/path_1234567890'), null);
  assert.equal(parseListingLink(link + '?utm_source=share').url, link);
});

test('checks each tariff on its own schedule, notifies changes and ignores an unchanged result', async () => {
  const db = openStore(':memory:');
  let time = 1000;
  setPlan(db, 2, 'medium', time);
  setPlan(db, 3, 'fast', time);
  for (const user of [1, 2, 3]) assert.equal(addWatches(db, user, [item, item], time), 1);
  assert.deepEqual(db.prepare('SELECT due_at FROM watches ORDER BY user_id').all().map(row => row.due_at), [1180, 1060, 1030]);
  const messages = [];
  let lookups = 0;
  let state = active(100);
  const worker = createWatchWorker(db, async () => { lookups++; return state; }, async (_, msg) => messages.push(msg), () => time);
  async function tick(at) {
    time = at;
    await worker.checkDue();
    await worker.deliverQueued();
  }
  await tick(1029);
  assert.equal(lookups, 0);
  await tick(1030);
  assert.deepEqual(messages.map(msg => msg.chat_id), [3]);
  assert.match(messages[0].text, /Первая проверка/);
  await tick(1060);
  assert.equal(lookups, 2);
  assert.deepEqual(messages.map(msg => msg.chat_id), [3, 2]);
  state = active(80);
  await tick(1090);
  assert.match(messages.at(-1).text, /Было: 100 ₽\nСтало: 80 ₽\nСнижение: 20 ₽ \(20%\)/);
  await tick(1120);
  assert.deepEqual(messages.map(msg => msg.chat_id), [3, 2, 3, 2]);
  state = { status: 'unavailable', price: null, title: null };
  await tick(1180);
  assert.match(messages.find(msg => msg.chat_id === 1).text, /объявление недоступно/i);
  assert.match(messages.at(-1).text, /стало недоступно/);
  db.close();
});

test('preserves last known status on lookup failure and retries queued messages', async t => {
  t.mock.method(console, 'error', () => {});
  const db = openStore(':memory:');
  let time = 1000;
  setPlan(db, 1, 'fast', time);
  addWatches(db, 1, [item], time);
  let failLookup = false;
  let sendAttempts = 0;
  const worker = createWatchWorker(db, async () => {
    if (failLookup) throw new Error('network error');
    return active(200);
  }, async () => {
    if (++sendAttempts === 1) throw Object.assign(new Error('rate limited'), { retryAfter: 17 });
  }, () => time);
  time = 1030;
  await worker.checkDue();
  await worker.deliverQueued();
  time = 1046;
  await worker.deliverQueued();
  assert.equal(sendAttempts, 1);
  time = 1047;
  await worker.deliverQueued();
  assert.equal(sendAttempts, 2);
  failLookup = true;
  time = 1060;
  await worker.checkDue();
  const watch = db.prepare('SELECT * FROM watches').get();
  assert.equal(watch.last_status, 'active');
  assert.equal(watch.checked_at, 1030);
  assert.equal(watch.due_at, 1090);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM watch_notifications').get().count, 0);
  db.close();
});

test('bot restricts plan assignment to the owner and removal to the tracking user', async () => {
  const db = openStore(':memory:');
  const messages = [];
  const send = async (_, msg) => messages.push(msg);
  const config = { owner: 9, watchUrl: new URL('https://feed.example.test/lookup'), publicUrl: 'https://example.test' };
  const dispatch = (id, text, now) => handleBotUpdate(db, send, config,
    { message: { text, from: { id }, chat: { type: 'private', id } } }, now);
  await dispatch(1, link, 1000);
  assert.match(messages.at(-1).text, /через 3 мин/);
  await dispatch(1, '/tariff 1 fast', 1010);
  assert.equal(db.prepare('SELECT due_at FROM watches').get().due_at, 1180);
  await dispatch(9, '/tariff 1 fast', 1010);
  assert.equal(db.prepare('SELECT due_at FROM watches').get().due_at, 1040);
  await dispatch(9, '/unwatch ' + link, 1010);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM watches').get().count, 1);
  await dispatch(1, '/watches', 1010);
  assert.match(messages.at(-1).text, /1234567890/);
  const worker = createWatchWorker(db, async () => active(100), send, () => 1040);
  await worker.checkDue();
  await dispatch(1, '/unwatch 1234567890', 1041);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM watches').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM watch_notifications').get().count, 0);
  assert.equal(removeWatch(db, 1, 'invalid-link'), null);
  db.close();
});

test('refuses a source response referring to a different listing or an ambiguous status', () => {
  assert.throws(() => validateSnapshot({ id: 'other', status: 'active' }, item.id));
  assert.throws(() => validateSnapshot({ id: item.id, status: 'timeout' }, item.id));
  assert.deepEqual(validateSnapshot({ id: item.id, status: 'unavailable' }, item.id), {
    status: 'unavailable', title: null, price: null,
  });
});

test('checks an Avito public listing by ID and separates removal from provider failures', async () => {
  let response = { id: Number(item.id), closed: false, title: 'Смартфон', price: 64900 };
  let status = 200;
  const config = { watchApiKey: 'fixture-token' };
  assert.equal(hasLookup(config), true);
  assert.equal(hasLookup({ searchKey: 'fixture-only' }), false);
  const lookup = createLookup(config, async (url, options) => {
    assert.equal(url.origin + url.pathname, 'https://api.api.sh/avito/v1/listing');
    assert.equal(url.searchParams.get('id'), item.id);
    assert.equal(url.searchParams.get('fresh'), '1');
    assert.equal(options.headers['x-api-key'], config.watchApiKey);
    return Response.json(response, { status });
  });
  const watch = { listing_id: item.id, url: item.url };
  assert.deepEqual(await lookup(watch), active(64900));
  response = { ...response, closed: true };
  assert.equal((await lookup(watch)).status, 'unavailable');
  response = { ...response, id: 1234567 };
  await assert.rejects(lookup(watch), /Unexpected listing response/);
  status = 429;
  await assert.rejects(lookup(watch), /429/);
  status = 404;
  assert.deepEqual(await lookup(watch), { status: 'unavailable', title: null, price: null });
});
