import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fetchAvitoSearch } from './avito-source.mjs';
import { handleBotUpdate } from './bot.mjs';
import { readParserConfig } from './parser-config.mjs';
import { claimParserJob, finishParserJob } from './parser-jobs.mjs';
import { listSavedSearches, saveSearch } from './saved-searches.mjs';
import { openStore } from './store.mjs';
import { createWatchWorker } from './watch-worker.mjs';

const searchUrl = 'https://www.avito.ru/moskva/telefony?q=fixture';
const asHtml = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const card = (id, price) => ({ id, title: 'ТЕСТ ' + id, url: 'https://www.avito.ru/moskva/telefony/test_' + id, price });
const one = card('9900000001', 150);
const two = card('9900000002', 200);

test('extracts listing IDs and prices from HTML and stops on 429 and CAPTCHA', async () => {
  const html = '<script data-mfe-state="true">' + JSON.stringify({ search: { items: [one, one, two] } }) + '</script>';
  const read = await fetchAvitoSearch(searchUrl, async (url, options) => {
    assert.equal(url, searchUrl);
    assert.equal(options.redirect, 'manual');
    return asHtml(html);
  });
  assert.deepEqual(read.rows, [one, two]);
  const visual = '<div data-marker="item" data-item-id="9900000001"><a data-marker="item-title" href="/moskva/telefony/test_9900000001">ТЕСТ 9900000001</a><meta itemprop="price" content="150"></div>';
  assert.deepEqual((await fetchAvitoSearch(searchUrl, async () => asHtml(visual))).rows, [one]);
  const denied = await fetchAvitoSearch(searchUrl, async () => asHtml('', 429, { 'retry-after': '60' }));
  assert.equal(denied.kind, 'blocked');
  assert.equal(denied.status, 429);
  assert.ok(denied.retryAt > Date.now() / 1000);
  assert.equal((await fetchAvitoSearch(searchUrl, async () => asHtml('<form id="captcha"></form>' + html))).reason, 'captcha');
  assert.equal((await fetchAvitoSearch(searchUrl, async () => asHtml('<title>Unknown</title>'))).kind, 'error');
  assert.deepEqual((await fetchAvitoSearch(searchUrl, async () => asHtml('<div data-marker="catalog-serp/no-results"></div>'))).rows, []);
  assert.equal((await fetchAvitoSearch('https://example.com/moskva', async () => assert.fail('Foreign host'))).reason, 'invalid_url');
});

test('stores one copy per ID, shares a search, and queues new cards and price changes without repeated notices', async () => {
  const db = openStore(':memory:');
  const subscribe = { sourceUrl: searchUrl, newEnabled: true, dropEnabled: true };
  for (const user of [1, 2]) saveSearch(db, user, subscribe, 0, { linkEnabled: true });
  const first = claimParserJob(db, 180, 30);
  assert.equal(claimParserJob(db, 180, 30), null);
  assert.equal(finishParserJob(db, first.token, { kind: 'ok', rows: [one, one] }, 180), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_notifications').get().n, 0);
  const second = claimParserJob(db, 360, 30);
  assert.equal(finishParserJob(db, second.token, { kind: 'ok', rows: [{ ...one, price: 100 }, two, two] }, 361), true);
  assert.equal(finishParserJob(db, second.token, { kind: 'ok', rows: [one] }, 362), false);
  const third = claimParserJob(db, 540, 30);
  assert.equal(finishParserJob(db, third.token, { kind: 'ok', rows: [{ ...one, price: 100 }, two] }, 540), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM parser_listings').get().n, 2);
  assert.match(listSavedSearches(db, 1)[0].latest_new, /9900000002/);
  const sent = [];
  const worker = createWatchWorker(db, null, async (_, message) => sent.push(message), () => 550);
  await worker.deliverQueued();
  await worker.deliverQueued();
  await worker.deliverQueued();
  assert.equal(sent.length, 4);
  assert.equal(sent.filter(message => message.text.startsWith('Новое объявление')).length, 2);
  db.close();
});

test('persists a global access pause on disk and retains Retry-After after an operator resumes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lotik-parser-'));
  let db = openStore(directory);
  try {
    saveSearch(db, 1, { sourceUrl: searchUrl, newEnabled: true, dropEnabled: false }, 0, { linkEnabled: true });
    const first = claimParserJob(db, 180, 30);
    assert.equal(finishParserJob(db, first.token, { kind: 'blocked', status: 429, retryAt: 250 }, 181), true);
    db.close();
    db = openStore(directory);
    assert.equal(claimParserJob(db, 999, 30), null);
    assert.equal(listSavedSearches(db, 1)[0].checked_at, null);
    db.exec("UPDATE parser_state SET paused_reason = NULL WHERE id = 1");
    assert.equal(claimParserJob(db, 249, 30), null);
    assert.ok(claimParserJob(db, 250, 30));
  } finally {
    db.close();
    unlinkSync(join(directory, 'radar.sqlite'));
    rmdirSync(directory);
  }
});

test('gates fixture and live modes and saves links received from a Telegram user', async () => {
  assert.throws(() => readParserConfig({ MODE: 'production', PARSER_MODE: 'fixture' }));
  assert.throws(() => readParserConfig({ MODE: 'production', PARSER_MODE: 'live' }));
  const db = openStore(':memory:');
  const sent = [];
  await handleBotUpdate(db, async (_, message) => sent.push(message), { parserMode: 'live' }, {
    message: { chat: { id: 7, type: 'private' }, from: { id: 7 }, text: searchUrl },
  }, 123);
  assert.match(sent[0].text, /Поиск сохранён/);
  assert.equal(listSavedSearches(db, 7)[0].source_url, searchUrl);
  db.close();
});
