import { createHash, randomBytes } from 'node:crypto';
import { transaction } from './store.mjs';
import { initializeLotikMarket } from './lotik-market-db.mjs';
import { createMarketPhotos, marketPhotoId } from './lotik-market-photos.mjs';

const pageSize = 16;
const telegramUsername = /^[a-z][a-z0-9_]{4,31}$/i;
const rules = Object.freeze({
  publish: [6, 3600], upload: [30, 3600], report: [8, 3600],
  contact: [10, 600], link: [6, 600], redeem: [12, 600],
});
const mutations = ['remove', 'sold', 'republish', 'delete'];
const modActions = ['approve', 'reject', 'remove', 'delete', 'block', 'unblock', 'resolve'];
const codeHash = code => createHash('sha256').update(code).digest('hex');
const fold = value => value.normalize('NFKC').toLocaleLowerCase('ru');
const numeric = value => /^\d{1,15}$/.test(String(value)) ? Number(value) : 0;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function text(value, max, label, required = true, lines = false) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if ((required && !cleaned) || cleaned.length > max || /[\x00-\x08\x0B-\x1F\x7F]/u.test(cleaned)
    || (!lines && /[\r\n]/.test(cleaned))) fail(400, 'Проверьте поле «' + label + '».');
  return cleaned;
}

function price(value, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const parsed = (typeof value === 'number' || typeof value === 'string') && /^\d{1,10}$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000_000) fail(400, 'Укажите цену в целых рублях.');
  return parsed;
}

export function createLotikMarket(db, dataDir, telegram, options = {}) {
  initializeLotikMarket(db);
  const photos = createMarketPhotos(db, dataDir, options.python);
  const getAd = db.prepare("SELECT * FROM lotik_market_ads WHERE id = ? AND status <> 'deleted'");
  let sweepAt = 0;

  function rate(actor, action, now) {
    const [max, period] = rules[action];
    const recent = db.prepare('SELECT COUNT(*) AS total FROM lotik_market_events WHERE actor = ? AND action = ? AND created_at > ?')
      .get(actor, action, now - period).total;
    if (recent >= max) fail(429, 'Слишком много действий. Попробуйте позже.');
    db.prepare('INSERT INTO lotik_market_events (actor, action, created_at) VALUES (?, ?, ?)').run(actor, action, now);
    if (now - sweepAt > 3600) {
      sweepAt = now;
      db.prepare('DELETE FROM lotik_market_events WHERE created_at <= ?').run(now - 3600);
      db.prepare('DELETE FROM lotik_market_link_codes WHERE expires_at <= ?').run(now);
      db.prepare('DELETE FROM lotik_market_replies WHERE expires_at <= ?').run(now);
    }
  }

  function actor(userId) {
    const id = userId > 0 ? userId : db.prepare('SELECT telegram_id FROM lotik_market_web_links WHERE web_id = ?').get(-userId)?.telegram_id;
    if (!id) return { id: null, username: null, blocked: false };
    const username = db.prepare('SELECT username FROM users WHERE id = ?').get(id)?.username;
    const blocked = Boolean(db.prepare('SELECT 1 FROM lotik_market_blocks WHERE telegram_id = ?').get(id));
    return { id, blocked, username: telegramUsername.test(username ?? '') ? username : null };
  }

  function requireActor(userId) {
    const result = actor(userId);
    if (!result.id) fail(403, 'Подтвердите свой Telegram в кабинете, чтобы продолжить.');
    if (result.blocked) fail(403, 'Действия в Маркете ограничены модератором.');
    return result;
  }

  function publicAd(id) {
    const ad = getAd.get(id);
    if (ad?.status !== 'active') fail(404, 'Объявление недоступно.');
    return ad;
  }

  function ownedAd(id, userId) {
    const ad = getAd.get(id);
    if (!ad || (ad.owner_id !== userId && ad.telegram_id !== actor(userId).id)) fail(404, 'Объявление недоступно.');
    return ad;
  }

  function publicUsername(ad) {
    const username = actor(ad.telegram_id).username;
    return username && username === ad.contact_username ? username : null;
  }

  function detail(ad, userId, ownerMode) {
    const images = db.prepare('SELECT id FROM lotik_market_photos WHERE ad_id = ? ORDER BY position').all(ad.id);
    const username = ownerMode ? null : publicUsername(ad);
    return {
      id: ad.id, title: ad.title, price: ad.price, city: ad.city, district: ad.district,
      category: ad.category, description: ad.description, status: ad.status,
      publishedAt: ad.published_at, photos: images.map(item => item.id),
      own: ad.owner_id === userId || ad.telegram_id === actor(userId).id,
      saved: Boolean(db.prepare('SELECT 1 FROM lotik_market_favorites WHERE ad_id = ? AND user_id = ?').get(ad.id, userId)),
      ...(ownerMode ? { revision: ad.revision, moderationNote: ad.moderation_note, contact: ad.contact_username ? 'username' : 'bot' }
        : { telegramUrl: username ? 'https://t.me/' + username : null }),
    };
  }

  function browse(userId, params, mode) {
    const filters = [];
    const args = [userId, userId, actor(userId).id ?? 0];
    let order = 'a.published_at DESC, a.id DESC';
    const cursor = numeric(params.get('cursor'));
    if (mode === 'mine') {
      filters.push("(a.owner_id = ? OR a.telegram_id = ?) AND a.status <> 'deleted'");
      args.push(userId, actor(userId).id ?? 0);
      order = 'a.id DESC';
    } else if (mode === 'mod') {
      filters.push("a.status <> 'deleted'");
      if (params.get('queue') === 'reports') filters.push('EXISTS (SELECT 1 FROM lotik_market_reports r WHERE r.ad_id = a.id AND r.resolved_at IS NULL)');
      else if (params.get('queue') === 'all') filters.push('1 = 1');
      else filters.push("a.status = 'pending'");
      order = 'a.id DESC';
    } else {
      filters.push("a.status = 'active'");
      if (mode === 'saved') {
        filters.push('EXISTS (SELECT 1 FROM lotik_market_favorites f WHERE f.user_id = ? AND f.ad_id = a.id)');
        args.push(userId);
      }
      const query = text(params.get('q'), 100, 'Поиск', false);
      const tokens = query.match(/[\p{L}\p{N}]+/gu);
      if (tokens?.length) {
        filters.push('a.id IN (SELECT rowid FROM lotik_market_fts WHERE lotik_market_fts MATCH ?)');
        args.push(tokens.map(token => '"' + token + '"*').join(' AND '));
      }
      for (const [param, field] of [['category', 'category'], ['city', 'city_key']]) {
        const value = text(params.get(param), 80, 'Фильтр', false);
        if (value) {
          filters.push('a.' + field + ' = ?');
          args.push(fold(value));
        }
      }
      const min = price(params.get('min'), true);
      const max = price(params.get('max'), true);
      if (min !== null && max !== null && min > max) fail(400, 'Минимальная цена выше максимальной.');
      if (min !== null) { filters.push('a.price >= ?'); args.push(min); }
      if (max !== null) { filters.push('a.price <= ?'); args.push(max); }
      const sort = params.get('sort');
      if (sort === 'cheap') order = 'a.price ASC, a.id DESC';
      if (sort === 'expensive') order = 'a.price DESC, a.id DESC';
    }
    const previous = cursor && db.prepare('SELECT id,price,published_at FROM lotik_market_ads WHERE id = ?').get(cursor);
    if (previous) {
      if (order.startsWith('a.price')) {
        filters.push('(a.price ' + (order.includes('ASC') ? '>' : '<') + ' ? OR (a.price = ? AND a.id < ?))');
        args.push(previous.price, previous.price, previous.id);
      } else if (order.startsWith('a.published_at')) {
        filters.push('(a.published_at, a.id) < (?, ?)');
        args.push(previous.published_at, previous.id);
      } else {
        filters.push('a.id < ?');
        args.push(previous.id);
      }
    }
    const rows = db.prepare(`
      SELECT a.id, a.title, a.price, a.city, a.status, a.published_at AS publishedAt, a.created_at AS createdAt,
        (SELECT p.id FROM lotik_market_photos p WHERE p.ad_id = a.id ORDER BY p.position LIMIT 1) AS cover,
        EXISTS (SELECT 1 FROM lotik_market_favorites f WHERE f.user_id = ? AND f.ad_id = a.id) AS saved,
        (a.owner_id = ? OR a.telegram_id = ?) AS own
      FROM lotik_market_ads a WHERE ${filters.join(' AND ')} ORDER BY ${order} LIMIT ?
    `).all(...args, pageSize + 1);
    const result = rows.slice(0, pageSize);
    return { rows: result, next: rows.length > pageSize ? result.at(-1).id : null };
  }

  function save(userId, input, now, id) {
    const identity = requireActor(userId);
    const title = text(input?.title, 100, 'Название');
    const description = text(input?.description, 2500, 'Описание', true, true);
    const city = text(input?.city, 80, 'Город');
    const district = text(input?.district, 80, 'Район', false);
    const category = text(input?.category, 32, 'Категория');
    if (!db.prepare('SELECT 1 FROM lotik_market_categories WHERE id = ?').get(category)) fail(400, 'Выберите категорию.');
    const amount = price(input.price);
    const selected = input.photos;
    if (!Array.isArray(selected) || selected.length > 5 || new Set(selected).size !== selected.length
      || selected.some(key => typeof key !== 'string' || !marketPhotoId.test(key))) fail(400, 'Выберите до пяти фотографий.');
    if (!['bot', 'username'].includes(input.contact) || (input.contact === 'username' && !identity.username)) {
      fail(400, 'Выберите доступный способ связи через Telegram.');
    }
    if (input.acceptRules !== true) fail(400, 'Подтвердите правила публикации.');
    const username = input.contact === 'username' ? identity.username : null;
    const search = fold(title + ' ' + description);
    return transaction(db, () => {
      const before = id ? ownedAd(id, userId) : null;
      if (before && before.revision !== input.revision) fail(409, 'Объявление изменилось. Откройте его снова.');
      if (before?.status === 'sold') fail(409, 'Проданное объявление можно удалить.');
      rate(identity.id, 'publish', now);
      const getPhoto = db.prepare('SELECT owner_id, ad_id, created_at FROM lotik_market_photos WHERE id = ?');
      for (const key of selected) {
        const photo = getPhoto.get(key);
        if (!photo || (photo.ad_id === null
          ? photo.owner_id !== userId || photo.created_at <= now - 86400
          : !before || photo.ad_id !== id)) {
          fail(400, 'Фотография недоступна. Загрузите её снова.');
        }
      }
      const values = [title, description, search, amount, category, city, fold(city), district, username];
      if (before) {
        db.prepare(`UPDATE lotik_market_ads SET title=?,description=?,search_text=?,price=?,category=?,city=?,city_key=?,district=?,
          contact_username=?,status='pending',moderation_note='',updated_at=?,revision=revision+1 WHERE id=?`).run(...values, now, id);
      } else {
        id = Number(db.prepare(`INSERT INTO lotik_market_ads (owner_id,telegram_id,title,description,search_text,price,
          category,city,city_key,district,contact_username,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(userId, identity.id, ...values, now, now).lastInsertRowid);
      }
      const removed = db.prepare('SELECT id FROM lotik_market_photos WHERE ad_id = ?').all(id)
        .map(photo => photo.id).filter(key => !selected.includes(key));
      for (const key of removed) db.prepare('DELETE FROM lotik_market_photos WHERE id = ?').run(key);
      const attach = db.prepare('UPDATE lotik_market_photos SET ad_id = ?, position = ? WHERE id = ?');
      selected.forEach((key, position) => attach.run(id, position, key));
      return { id, removed };
    });
  }

  function updateStatus(ad, action, note, now) {
    const next = { approve: 'active', reject: 'rejected', remove: 'removed', sold: 'sold', republish: 'pending', delete: 'deleted' }[action];
    const permitted = {
      approve: ['pending'], reject: ['pending', 'active'], remove: ['pending', 'active'],
      sold: ['active','removed'], republish: ['removed','rejected'], delete: ['pending','active','removed','sold','rejected'],
    };
    if (!permitted[action]?.includes(ad.status)) fail(409, 'Действие недоступно для текущего статуса.');
    if (action === 'approve' && actor(ad.telegram_id).blocked) fail(409, 'Продавец заблокирован.');
    db.prepare(`UPDATE lotik_market_ads SET status=?,updated_at=?,moderation_note=?,published_at=?,revision=revision+1 WHERE id=?`)
      .run(next, now, note, next === 'active' ? now : ad.published_at, ad.id);
    if (action === 'delete') {
      const ids = db.prepare('DELETE FROM lotik_market_photos WHERE ad_id = ? RETURNING id').all(ad.id).map(row => row.id);
      db.prepare('DELETE FROM lotik_market_favorites WHERE ad_id = ?').run(ad.id);
      db.prepare("UPDATE lotik_market_ads SET search_text='', description='', district='', contact_username=NULL WHERE id = ?").run(ad.id);
      return ids;
    }
    return [];
  }

  function linkAccount(userId, input, now) {
    if (userId < 0) {
      rate(userId, 'link', now);
      if (actor(userId).id) fail(409, 'Telegram уже подтверждён.');
      const code = randomBytes(10).toString('hex');
      db.prepare(`INSERT INTO lotik_market_link_codes VALUES (?, ?, ?) ON CONFLICT(web_id)
        DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at`).run(codeHash(code), -userId, now + 600);
      return { code, expiresAt: now + 600 };
    }
    rate(userId, 'redeem', now);
    const code = typeof input?.code === 'string' ? input.code.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{20}$/.test(code) || input.confirm !== true) fail(400, 'Проверьте код и подтвердите привязку к своему веб-аккаунту.');
    return transaction(db, () => {
      const hash = codeHash(code);
      const target = db.prepare('SELECT web_id FROM lotik_market_link_codes WHERE code_hash = ? AND expires_at > ?').get(hash, now);
      if (!target) fail(400, 'Код неверен или истёк.');
      if (db.prepare('SELECT 1 FROM lotik_market_web_links WHERE web_id = ? OR telegram_id = ?').get(target.web_id, userId)) {
        fail(409, 'Один из аккаунтов уже связан.');
      }
      db.prepare('INSERT INTO lotik_market_web_links VALUES (?, ?)').run(target.web_id, userId);
      db.prepare('DELETE FROM lotik_market_link_codes WHERE code_hash = ?').run(hash);
      return { linked: true };
    });
  }

  async function deliver(recipient, peer, ad, message, now) {
    const sent = await telegram('sendMessage', {
      chat_id: recipient, text: 'Lotik Market · ' + ad.title + '\n\n' + message
        + '\n\nЧтобы ответить, используйте «Ответить» на это сообщение бота.',
      link_preview_options: { is_disabled: true },
    });
    if (!Number.isSafeInteger(sent?.message_id)) fail(502, 'Telegram не подтвердил отправку.');
    db.prepare('INSERT OR REPLACE INTO lotik_market_replies VALUES (?, ?, ?, ?, ?)')
      .run(recipient, sent.message_id, peer, ad.id, now + 604800);
  }

  async function relayReply(update, now) {
    const message = update?.message;
    const from = message?.from?.id;
    if (!message?.text || message.chat?.type !== 'private' || message.chat.id !== from || !message.reply_to_message?.message_id) return false;
    const thread = db.prepare('SELECT peer,ad_id FROM lotik_market_replies WHERE recipient = ? AND message_id = ? AND expires_at > ?')
      .get(from, message.reply_to_message.message_id, now);
    if (!thread) return false;
    try {
      requireActor(from);
      requireActor(thread.peer);
      rate(from, 'contact', now);
      await deliver(thread.peer, from, publicAd(thread.ad_id), text(message.text, 800, 'Сообщение', true, true), now);
    } catch (error) {
      await telegram('sendMessage', { chat_id: from, text: error.status ? error.message : 'Ответ не доставлен. Собеседник мог закрыть чат с ботом.' })
        .catch(() => {});
    }
    return true;
  }

  async function publicImage(id) {
    if (!marketPhotoId.test(id) || !db.prepare(`SELECT 1 FROM lotik_market_photos p JOIN lotik_market_ads a ON a.id=p.ad_id
      WHERE p.id=? AND a.status='active'`).get(id)) fail(404, 'Фото не найдено.');
    return photos.read(id);
  }

  async function route({ path, req, url, userId, isOwner, now, body }) {
    const method = req.method;
    const params = url.searchParams;
    if (path === '/meta' && method === 'GET') {
      const identity = actor(userId);
      return {
        categories: db.prepare('SELECT * FROM lotik_market_categories ORDER BY rowid').all(),
        cities: db.prepare("SELECT MIN(city) AS name FROM lotik_market_ads WHERE status='active' GROUP BY city_key ORDER BY name LIMIT 300").all().map(row => row.name),
        linked: Boolean(identity.id), username: identity.username, blocked: identity.blocked,
      };
    }
    if (path === '/link' && method === 'POST') return linkAccount(userId, userId < 0 ? null : await body(req), now);
    if (path === '/photos' && method === 'POST') {
      const identity = requireActor(userId);
      rate(identity.id, 'upload', now);
      return photos.upload(req, userId, now);
    }
    const image = /^\/photos\/([a-f0-9]{32})$/.exec(path);
    if (image && method === 'GET') {
      const asset = db.prepare(`SELECT p.owner_id, a.telegram_id FROM lotik_market_photos p
        LEFT JOIN lotik_market_ads a ON a.id=p.ad_id WHERE p.id=?`).get(image[1]);
      if (!asset || (!isOwner && asset.owner_id !== userId && (!asset.telegram_id || asset.telegram_id !== actor(userId).id))) {
        fail(404, 'Фото не найдено.');
      }
      return photos.read(image[1]);
    }
    if (path === '/ads' && method === 'GET') return browse(userId, params, 'active');
    if (path === '/mine' && method === 'GET') return browse(userId, params, 'mine');
    if (path === '/favorites' && method === 'GET') return browse(userId, params, 'saved');
    if (path === '/ads' && method === 'POST') return { id: save(userId, await body(req), now).id, status: 'pending' };
    if (path.startsWith('/moderation')) {
      if (!isOwner) fail(403, 'Доступ только владельцу.');
      if (path === '/moderation' && method === 'GET') return browse(userId, params, 'mod');
      const id = numeric(/^\/moderation\/([\d]+)$/.exec(path)?.[1]);
      const ad = id && getAd.get(id);
      if (!ad) fail(404, 'Объявление недоступно.');
      if (method === 'GET') return {
        ...detail(ad, userId, true), blocked: actor(ad.telegram_id).blocked,
        reports: db.prepare('SELECT reason,created_at AS createdAt FROM lotik_market_reports WHERE ad_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 40').all(id),
      };
      if (method === 'POST') {
        const input = await body(req);
        if (!modActions.includes(input?.action)) fail(400, 'Неизвестное действие.');
        const note = text(input.note, 300, 'Причина', input.action === 'reject');
        const removed = transaction(db, () => {
          const fresh = getAd.get(id);
          if (!fresh || fresh.revision !== input.revision) fail(409, 'Объявление изменилось. Откройте его снова.');
          let files = [];
          if (input.action === 'block') {
            db.prepare('INSERT OR IGNORE INTO lotik_market_blocks VALUES (?, ?)').run(fresh.telegram_id, now);
            db.prepare(`UPDATE lotik_market_ads SET status='removed', moderation_note=?, updated_at=?,revision=revision+1
              WHERE telegram_id=? AND status IN ('pending','active')`).run(note || 'Ограничение модератора.', now, fresh.telegram_id);
          } else if (input.action === 'unblock') {
            db.prepare('DELETE FROM lotik_market_blocks WHERE telegram_id=?').run(fresh.telegram_id);
          } else if (input.action !== 'resolve') {
            files = updateStatus(fresh, input.action, note, now);
          }
          if (['remove','delete','reject','block','resolve'].includes(input.action)) {
            db.prepare('UPDATE lotik_market_reports SET resolved_at=? WHERE ad_id=? AND resolved_at IS NULL').run(now,id);
          }
          return files;
        });
        await photos.remove(removed);
        return { ok: true };
      }
    }
    const match = /^\/ads\/(\d{1,15})(?:\/(edit|status|favorite|report|contact))?$/.exec(path);
    if (!match) fail(404, 'Раздел не найден.');
    const [, rawId, action] = match;
    const id = Number(rawId);
    if (!action && method === 'GET') return detail(publicAd(id), userId, false);
    if (action === 'edit' && method === 'GET') return detail(ownedAd(id, userId), userId, true);
    if (action === 'edit' && method === 'PUT') {
      const result = save(userId, await body(req), now, id);
      await photos.remove(result.removed);
      return { id, status: 'pending' };
    }
    if (action === 'status' && method === 'POST') {
      const input = await body(req);
      if (!mutations.includes(input?.action)) fail(400, 'Неизвестное действие.');
      if (input.action !== 'delete' && input.action !== 'remove') requireActor(userId);
      const removed = transaction(db, () => {
        const ad = ownedAd(id, userId);
        if (ad.revision !== input.revision) fail(409, 'Объявление изменилось. Откройте его снова.');
        if (input.action === 'republish') rate(ad.telegram_id, 'publish', now);
        return updateStatus(ad, input.action, '', now);
      });
      await photos.remove(removed);
      return { ok: true };
    }
    if (action === 'favorite' && method === 'PUT') {
      const input = await body(req);
      if (typeof input?.saved !== 'boolean') fail(400, 'Некорректное действие.');
      if (input.saved) {
        const ad = publicAd(id);
        if (ad.owner_id === userId || ad.telegram_id === actor(userId).id) fail(400, 'Это ваше объявление.');
        db.prepare('INSERT OR IGNORE INTO lotik_market_favorites VALUES (?, ?)').run(userId, id);
      } else db.prepare('DELETE FROM lotik_market_favorites WHERE user_id=? AND ad_id=?').run(userId, id);
      return { saved: input.saved };
    }
    if (action === 'report' && method === 'POST') {
      const input = await body(req);
      const ad = publicAd(id);
      const reporter = actor(userId);
      if (reporter.blocked) fail(403, 'Действия в Маркете ограничены модератором.');
      if (ad.owner_id === userId || ad.telegram_id === reporter.id) fail(400, 'Это ваше объявление.');
      const reason = text(input?.reason, 350, 'Причина жалобы');
      rate(userId, 'report', now);
      db.prepare('INSERT OR IGNORE INTO lotik_market_reports (ad_id,reporter_id,reason,created_at) VALUES (?,?,?,?)')
        .run(id, userId, reason, now);
      return { ok: true };
    }
    if (action === 'contact' && method === 'POST') {
      const input = await body(req);
      const buyer = requireActor(userId);
      const ad = publicAd(id);
      if (buyer.id === ad.telegram_id) fail(400, 'Это ваше объявление.');
      if (publicUsername(ad)) fail(409, 'Откройте Telegram продавца из объявления.');
      const message = text(input?.message, 800, 'Сообщение', true, true);
      rate(buyer.id, 'contact', now);
      try {
        await telegram('sendMessage', { chat_id: buyer.id, text: 'Lotik Market · Сюда поступают ответы продавцов.' });
        await deliver(ad.telegram_id, buyer.id, ad, message, now);
      } catch {
        fail(409, 'Сообщение не доставлено. Покупатель и продавец должны открыть чат с ботом Lotik и нажать «Старт».');
      }
      return { ok: true };
    }
    fail(405, 'Действие недоступно.');
  }

  return { route, publicImage, relayReply };
}
