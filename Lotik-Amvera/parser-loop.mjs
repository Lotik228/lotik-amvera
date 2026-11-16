import { setTimeout as delay } from 'node:timers/promises';
import { fetchAvitoSearch } from './avito-source.mjs';

function fixture(checkedAt) {
  const sample = [{ id: 9900000001, url: '/moskva/telefony/test_9900000001', title: 'ТЕСТ · телефон', price: 30000 }];
  if (checkedAt !== null) sample.push({ id: 9900000002, url: '/moskva/telefony/test_9900000002', title: 'ТЕСТ · новый телефон', price: 25000 });
  const html = '<script data-mfe-state="true">' + JSON.stringify({ search: { items: sample } }) + '</script>';
  return async () => new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

export async function runParser({ mode, claim, finish, stopping }) {
  function log(event, details = {}) {
    console.log(JSON.stringify({ at: new Date().toISOString(), event, mode, ...details }));
  }

  log('parser_started');
  let pending;
  while (!stopping() || pending) {
    if (mode === 'off') {
      await delay(1000);
      continue;
    }
    try {
      if (!pending) {
        const job = await claim();
        if (!job) {
          await delay(1000);
          continue;
        }
        const start = performance.now();
        let result;
        try { result = await fetchAvitoSearch(job.url, mode === 'fixture' ? fixture(job.checkedAt) : fetch); }
        catch (error) { result = { kind: 'error', reason: error.name === 'TimeoutError' ? 'timeout' : 'network_error' }; }
        pending = { token: job.token, result, searchId: job.id };
        log('search_checked', { searchId: job.id, state: result.kind, status: result.status,
          reason: result.reason, count: result.rows?.length, ms: Math.round(performance.now() - start) });
      }
      const accepted = await finish(pending);
      // A lost acknowledgement after a block must never lead to another source request.
      if (!accepted && pending.result.kind === 'blocked') {
        log('blocked_without_storage_acknowledgement', { searchId: pending.searchId });
        while (!stopping()) await delay(1000);
      }
      pending = undefined;
    } catch (error) {
      log('storage_unavailable', { reason: error.name });
      if (stopping()) break;
      await delay(2000);
    }
  }
}
