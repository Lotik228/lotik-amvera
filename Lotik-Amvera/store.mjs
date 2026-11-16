import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openStore(dataDir, journalMode = process.env.SQLITE_JOURNAL_MODE || 'wal') {
  if (!['wal', 'delete'].includes(journalMode)) throw new Error('Invalid SQLITE_JOURNAL_MODE');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dataDir === ':memory:' ? dataDir : join(dataDir, 'radar.sqlite'));
  db.exec(`
    PRAGMA busy_timeout = 4000;
    PRAGMA journal_mode = ${journalMode};
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL,
      ad_id TEXT NOT NULL,
      PRIMARY KEY (user_id, ad_id)
    );
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      city TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL,
      url TEXT NOT NULL,
      posted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feed_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      refreshed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_listings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      city TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER,
      url TEXT NOT NULL,
      posted_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS market_listings_updated ON market_listings(updated_at);
    CREATE INDEX IF NOT EXISTS favorites_ad_id ON favorites(ad_id);
    CREATE TABLE IF NOT EXISTS web_accounts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS web_sessions_expiration ON web_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS card_orders (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      amount_minor INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      attempt_json TEXT NOT NULL,
      payment_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      paid_at INTEGER,
      expires_at INTEGER,
      is_test INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_orders_account_idx ON card_orders(account_id, status, expires_at);
    CREATE TABLE IF NOT EXISTS card_refunds (
      refund_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watch_plans (
      user_id INTEGER PRIMARY KEY,
      plan TEXT NOT NULL CHECK (plan IN ('basic', 'medium', 'fast'))
    );
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      listing_id TEXT NOT NULL,
      url TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER,
      last_status TEXT,
      last_price INTEGER,
      last_title TEXT,
      UNIQUE (user_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS watches_due_idx ON watches(due_at);
    CREATE TABLE IF NOT EXISTS watch_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      retry_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS watch_notifications_retry_idx ON watch_notifications(retry_at);
    CREATE INDEX IF NOT EXISTS watch_notifications_user_idx ON watch_notifications(user_id, id);
    CREATE INDEX IF NOT EXISTS watch_notifications_watch_idx ON watch_notifications(watch_id);
    CREATE TABLE IF NOT EXISTS api_budget (
      period TEXT PRIMARY KEY,
      credits INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      city TEXT NOT NULL,
      max_price INTEGER NOT NULL,
      checked_at INTEGER,
      source_url TEXT,
      UNIQUE (query, city, max_price)
    );
    CREATE TABLE IF NOT EXISTS saved_search_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      new_enabled INTEGER NOT NULL,
      drop_enabled INTEGER NOT NULL,
      new_cursor INTEGER NOT NULL DEFAULT 0,
      drop_cursor INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL,
      UNIQUE (search_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS saved_search_users_due ON saved_search_users(due_at, search_id);
    CREATE INDEX IF NOT EXISTS saved_search_users_user ON saved_search_users(user_id);
    CREATE TABLE IF NOT EXISTS parser_listings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      price INTEGER,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parser_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      source_mode TEXT CHECK(source_mode IN ('fixture', 'live')),
      paused_reason TEXT,
      next_request_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0,
      search_id INTEGER
    );
    INSERT OR IGNORE INTO parser_state (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS saved_search_seen (
      search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL,
      price INTEGER,
      PRIMARY KEY (search_id, listing_id)
    );
    CREATE TABLE IF NOT EXISTS saved_search_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      previous_price INTEGER,
      price INTEGER,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS saved_search_events_search ON saved_search_events(search_id, id);
    CREATE TABLE IF NOT EXISTS search_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL REFERENCES saved_search_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      retry_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS search_notices_due ON search_notifications(retry_at);
    CREATE INDEX IF NOT EXISTS search_notices_user ON search_notifications(user_id, id);
    CREATE INDEX IF NOT EXISTS search_notices_subscription ON search_notifications(subscription_id);
    CREATE TABLE IF NOT EXISTS saved_search_activity (
      subscription_id INTEGER NOT NULL REFERENCES saved_search_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY(subscription_id, kind)
    );
    CREATE TABLE IF NOT EXISTS recent_alerts (
      user_id INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      notified_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS recent_alerts_at ON recent_alerts(notified_at);
  `);
  transaction(db, () => {
    const columns = db.prepare('PRAGMA table_info(saved_searches)').all();
    if (!columns.some(column => column.name === 'source_url')) {
      db.exec('ALTER TABLE saved_searches ADD COLUMN source_url TEXT');
    }
  });
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function cardAccess(db, accountId, now, testMode) {
  return db.prepare(`
    SELECT id, expires_at FROM card_orders
    WHERE account_id = ? AND status = 'succeeded' AND expires_at > ? AND is_test = ?
      AND amount_minor > COALESCE((SELECT SUM(amount_minor) FROM card_refunds WHERE order_id = card_orders.id), 0)
    ORDER BY expires_at DESC LIMIT 1
  `).get(accountId, now, Number(testMode));
}
