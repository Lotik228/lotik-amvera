import { randomUUID } from 'node:crypto';
import { applySearchResults } from './saved-searches.mjs';
import { transaction } from './store.mjs';
import { parseListingLink } from './watches.mjs';

const getState = db => db.prepare('SELECT * FROM parser_state WHERE id = 1').get();

export function initializeParserStorage(db, mode) {
  if (mode === 'off') return;
  const { source_mode } = db.prepare(`
    UPDATE parser_state SET source_mode = COALESCE(source_mode, ?) WHERE id = 1 RETURNING source_mode
  `).get(mode);
  if (source_mode !== mode) throw new Error('Use separate SQLite storage for fixture and live modes');
}

export function claimParserJob(db, now, gap) {
  return transaction(db, () => {
    const state = getState(db);
    if (state.paused_reason || state.next_request_at > now || state.lease_until > now) return null;
    const job = db.prepare(`
      SELECT s.id, s.source_url AS url, s.checked_at AS checkedAt
      FROM saved_searches s JOIN saved_search_users u ON u.search_id = s.id
      WHERE s.source_url IS NOT NULL AND u.user_id <> 0 AND u.due_at <= ? AND (u.new_enabled OR u.drop_enabled)
      GROUP BY s.id ORDER BY MIN(u.due_at), s.id LIMIT 1
    `).get(now);
    if (!job) return null;
    const token = randomUUID();
    db.prepare('UPDATE parser_state SET lease_token = ?, search_id = ?, lease_until = ?, next_request_at = ? WHERE id = 1')
      .run(token, job.id, now + 60, now + gap);
    return { ...job, token };
  });
}

function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid parser rows');
  const unique = new Map();
  for (const row of rows) {
    const link = parseListingLink(row?.url);
    if (!link || link.id !== row.id || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 250
      || !(row.price === null || (Number.isSafeInteger(row.price) && row.price >= 0 && row.price <= 1e12))) {
      throw new Error('Invalid parser listing');
    }
    unique.set(link.id, { ...link, title: row.title, price: row.price });
  }
  return [...unique.values()];
}

export function finishParserJob(db, token, result, now) {
  if (typeof token !== 'string' || !['ok', 'error', 'blocked'].includes(result?.kind)) throw new Error('Invalid parser result');
  const rows = result.kind === 'ok' ? normalizeRows(result.rows) : null;
  return transaction(db, () => {
    const state = getState(db);
    if (state.lease_token !== token || state.lease_until <= now) return false;
    const retryAt = Number.isSafeInteger(result.retryAt) ? result.retryAt : 0;
    const status = Number.isInteger(result.status) ? result.status : 0;
    const paused = result.kind === 'blocked'
      ? (result.reason === 'captcha' ? 'captcha' : 'http_' + status) : null;
    const failures = result.kind === 'ok' ? 0 : state.failures + 1;
    const delay = result.kind === 'error' ? Math.min(900, 15 * 2 ** Math.min(failures, 6)) : 0;
    if (rows) {
      const save = db.prepare(`
        INSERT INTO parser_listings (id, title, url, price, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url,
          price = COALESCE(excluded.price, parser_listings.price), last_seen = excluded.last_seen
      `);
      for (const row of rows) save.run(row.id, row.title, row.url, row.price, now, now);
    }
    if (!paused) applySearchResults(db, state.search_id, rows, now);
    db.prepare(`
      UPDATE parser_state SET paused_reason = ?, failures = ?, next_request_at = MAX(next_request_at, ?, ?),
        lease_token = NULL, search_id = NULL, lease_until = 0 WHERE id = 1
    `).run(paused, failures, retryAt, now + delay);
    return true;
  });
}
