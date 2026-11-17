export function initializeLotikMarket(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lotik_market_categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL
    );
    INSERT OR IGNORE INTO lotik_market_categories VALUES
      ('electronics', 'Электроника'), ('home', 'Дом и сад'), ('fashion', 'Одежда и аксессуары'),
      ('sports', 'Спорт и отдых'), ('children', 'Детские товары'), ('hobby', 'Хобби и коллекции'),
      ('other', 'Другое');
    CREATE TABLE IF NOT EXISTS lotik_market_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, telegram_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL, search_text TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0),
      category TEXT NOT NULL REFERENCES lotik_market_categories(id), city TEXT NOT NULL, city_key TEXT NOT NULL,
      district TEXT NOT NULL, contact_username TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','active','sold','removed','rejected','deleted')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER, moderation_note TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS lotik_market_ads_feed ON lotik_market_ads(status, published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS lotik_market_ads_price ON lotik_market_ads(status, price, id);
    CREATE INDEX IF NOT EXISTS lotik_market_ads_filter ON lotik_market_ads(status, category, city_key, published_at DESC);
    CREATE INDEX IF NOT EXISTS lotik_market_ads_owner ON lotik_market_ads(owner_id, id DESC);
    CREATE INDEX IF NOT EXISTS lotik_market_ads_telegram ON lotik_market_ads(telegram_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS lotik_market_fts USING fts5(search_text, tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS lotik_market_fts_insert AFTER INSERT ON lotik_market_ads BEGIN
      INSERT INTO lotik_market_fts(rowid, search_text) VALUES (new.id, new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS lotik_market_fts_update AFTER UPDATE OF search_text ON lotik_market_ads BEGIN
      DELETE FROM lotik_market_fts WHERE rowid = old.id;
      INSERT INTO lotik_market_fts(rowid, search_text) VALUES (new.id, new.search_text);
    END;
    CREATE TABLE IF NOT EXISTS lotik_market_photos (
      id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, ad_id INTEGER REFERENCES lotik_market_ads(id),
      position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lotik_market_photos_ad ON lotik_market_photos(ad_id, position);
    CREATE INDEX IF NOT EXISTS lotik_market_photos_drafts ON lotik_market_photos(ad_id, created_at);
    CREATE TABLE IF NOT EXISTS lotik_market_favorites (
      user_id INTEGER NOT NULL, ad_id INTEGER NOT NULL REFERENCES lotik_market_ads(id), PRIMARY KEY(user_id, ad_id)
    );
    CREATE INDEX IF NOT EXISTS lotik_market_favorites_ad ON lotik_market_favorites(ad_id);
    CREATE TABLE IF NOT EXISTS lotik_market_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ad_id INTEGER NOT NULL REFERENCES lotik_market_ads(id),
      reporter_id INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER,
      UNIQUE(ad_id, reporter_id)
    );
    CREATE INDEX IF NOT EXISTS lotik_market_reports_open ON lotik_market_reports(resolved_at, ad_id);
    CREATE TABLE IF NOT EXISTS lotik_market_blocks (telegram_id INTEGER PRIMARY KEY, blocked_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lotik_market_web_links (
      web_id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS lotik_market_link_codes (
      code_hash TEXT PRIMARY KEY, web_id INTEGER NOT NULL UNIQUE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lotik_market_events (
      id INTEGER PRIMARY KEY, actor INTEGER NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lotik_market_events_rate ON lotik_market_events(actor, action, created_at);
    CREATE TABLE IF NOT EXISTS lotik_market_replies (
      recipient INTEGER NOT NULL, message_id INTEGER NOT NULL, peer INTEGER NOT NULL, ad_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, PRIMARY KEY(recipient, message_id)
    );
  `);
}
