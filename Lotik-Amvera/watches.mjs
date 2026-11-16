import { transaction } from './store.mjs';
import { claimAlert, dropText, isDrop, priceLabel } from './alerts.mjs';

export const plans = Object.freeze({
  basic: { name: 'Лотик Standart', seconds: 180, label: '3 мин', searchLimit: 1 },
  medium: { name: 'Лотик Pro', seconds: 60, label: '1 мин', searchLimit: 3 },
  fast: { name: 'Лотик Premium', seconds: 30, label: '30 сек', searchLimit: 5 },
});

const avitoHosts = new Set(['avito.ru', 'www.avito.ru', 'm.avito.ru']);
export const nextSlot = (now, seconds) => (Math.floor(now / seconds) + 1) * seconds;

export function parseListingLink(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().replace(/[),.;!\]>}»]+$/u, '');
  let url;
  try { url = new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !avitoHosts.has(url.host) || url.username || url.password) return null;
  const id = url.pathname.match(/_(\d{5,32})\/?$/)?.[1]
    ?? url.pathname.match(/^\/(?:i|items)\/(\d{5,32})\/?$/)?.[1];
  if (!id || url.pathname.length > 768) return null;
  return { id, url: 'https://www.avito.ru' + url.pathname.replace(/\/$/, '') };
}

export function extractMessageLinks(message) {
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const hiddenLinks = entities.filter(entity => entity.type === 'text_link').map(entity => entity.url);
  const visibleLinks = text.match(/https?:\/\/[^\s<>"«»]+|(?<![\w./@-])(?:www\.|m\.)?avito\.ru\/[^\s<>"«»]+/giu) ?? [];
  return [...visibleLinks, ...hiddenLinks];
}

export function extractLinks(message) {
  const listings = extractMessageLinks(message).map(parseListingLink).filter(Boolean);
  return [...new Map(listings.map(item => [item.id, item])).values()];
}

function userPlanKey(db, userId) {
  return db.prepare('SELECT plan FROM watch_plans WHERE user_id = ?').get(userId)?.plan ?? 'basic';
}

export function userPlan(db, userId) {
  return plans[userPlanKey(db, userId)];
}

export function setPlan(db, userId, key, now, { actorId, expectedPlan } = {}) {
  if (typeof key !== 'string' || !Object.hasOwn(plans, key)) return false;
  return transaction(db, () => {
    const previousPlan = userPlanKey(db, userId);
    if (previousPlan === key) return true;
    if (expectedPlan != null && previousPlan !== expectedPlan) {
      throw Object.assign(new Error('Тариф уже изменился. Найдите пользователя заново.'), { status: 409 });
    }
    db.prepare(`
      INSERT INTO watch_plans VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan
    `).run(userId, key);
    db.prepare('UPDATE watches SET due_at = ?, revision = revision + 1 WHERE user_id = ?')
      .run(now + plans[key].seconds, userId);
    db.prepare('UPDATE saved_search_users SET due_at = ? WHERE user_id = ?')
      .run(nextSlot(now, plans[key].seconds), userId);
    const paused = db.prepare(`
      UPDATE saved_search_users SET new_enabled = 0, drop_enabled = 0 WHERE id IN (
        SELECT id FROM saved_search_users WHERE user_id = ? AND (new_enabled OR drop_enabled)
        ORDER BY id LIMIT -1 OFFSET ?
      ) RETURNING id
    `).all(userId, plans[key].searchLimit);
    const cancel = db.prepare('DELETE FROM search_notifications WHERE subscription_id = ?');
    for (const sub of paused) cancel.run(sub.id);
    if (actorId != null) {
      db.prepare(`
        INSERT INTO owner_plan_changes (actor_id, user_id, previous_plan, new_plan, changed_at, paused_searches)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(actorId, userId, previousPlan, key, now, paused.length);
    }
    return true;
  });
}

export function addWatches(db, userId, listings, now) {
  return transaction(db, () => {
    const due = now + userPlan(db, userId).seconds;
    const insert = db.prepare('INSERT OR IGNORE INTO watches (user_id, listing_id, url, due_at) VALUES (?, ?, ?, ?)');
    let added = 0;
    for (const item of listings) added += insert.run(userId, item.id, item.url, due).changes;
    return added;
  });
}

export function removeWatch(db, userId, value) {
  if (typeof value !== 'string') return null;
  const id = parseListingLink(value)?.id ?? (/^\d{5,32}$/.test(value) ? value : null);
  if (!id) return null;
  return db.prepare('DELETE FROM watches WHERE user_id = ? AND listing_id = ?').run(userId, id).changes > 0;
}

export function listWatches(db, userId, page = 1) {
  const size = 10;
  const rows = db.prepare('SELECT * FROM watches WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(userId, size + 1, (page - 1) * size);
  return { rows: rows.slice(0, size), hasNext: rows.length > size };
}

export function watchStatus(row) {
  if (!row.last_status) return 'Ждёт первой проверки';
  return row.last_status === 'active' ? 'Активно · ' + priceLabel(row.last_price) : 'Объявление недоступно';
}

function changeText(watch, snapshot) {
  const title = snapshot.title || watch.last_title || 'Объявление ' + watch.listing_id;
  const status = snapshot.status === 'active' ? 'Активно · ' + priceLabel(snapshot.price) : 'Объявление недоступно';
  if (!watch.last_status) return 'Первая проверка\n' + title + '\n' + status + '\n' + watch.url;
  if (snapshot.status !== watch.last_status) {
    return (snapshot.status === 'active' ? 'Объявление снова активно' : 'Объявление стало недоступно')
      + '\n' + title + (snapshot.status === 'active' ? '\n' + priceLabel(snapshot.price) : '') + '\n' + watch.url;
  }
  if (snapshot.status === 'active' && snapshot.price !== watch.last_price) {
    if (isDrop(watch.last_price, snapshot.price)) return dropText(title, watch.url, watch.last_price, snapshot.price);
    return 'Цена изменилась\n' + title + '\n' + priceLabel(watch.last_price) + ' → ' + priceLabel(snapshot.price) + '\n' + watch.url;
  }
  return null;
}

export function finishCheck(db, watch, snapshot, now) {
  transaction(db, () => {
    const { seconds } = userPlan(db, watch.user_id);
    const elapsedIntervals = Math.max(0, Math.floor((now - watch.due_at) / seconds));
    const next = watch.due_at + seconds * (elapsedIntervals + 1);
    const result = db.prepare(`
      UPDATE watches SET due_at = ?, revision = revision + 1, checked_at = ?, last_status = ?, last_price = ?, last_title = ?
      WHERE id = ? AND revision = ?
    `).run(next, snapshot ? now : watch.checked_at, snapshot?.status ?? watch.last_status,
      snapshot ? snapshot.price : watch.last_price, snapshot?.title ?? watch.last_title, watch.id, watch.revision);
    if (!result.changes || !snapshot) return;
    const text = changeText(watch, snapshot);
    if (!text || watch.user_id <= 0) return;
    const drop = watch.last_status === 'active' && snapshot.status === 'active' && isDrop(watch.last_price, snapshot.price);
    if (drop && !claimAlert(db, watch.user_id, 'drop', watch.listing_id, watch.last_price, snapshot.price, now)) return;
    db.prepare('INSERT INTO watch_notifications (watch_id, user_id, text, retry_at) VALUES (?, ?, ?, ?)')
      .run(watch.id, watch.user_id, text, now);
  });
}
