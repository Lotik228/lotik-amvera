const rubles = new Intl.NumberFormat('ru-RU');
const pct = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
export const priceLabel = price => price === null ? 'цена не указана' : rubles.format(price) + ' ₽';
export const isDrop = (oldPrice, price) => Number.isSafeInteger(oldPrice) && Number.isSafeInteger(price) && price < oldPrice;

export function dropText(title, url, from, to) {
  const difference = from - to;
  return 'Цена снизилась\n' + title + '\nБыло: ' + priceLabel(from) + '\nСтало: ' + priceLabel(to)
    + '\nСнижение: ' + priceLabel(difference) + ' (' + pct.format(100 * difference / from) + '%)\n' + url;
}

export function claimAlert(db, userId, kind, listing, from, to, now) {
  const fingerprint = JSON.stringify(kind === 'drop' ? [kind, listing, from, to] : [kind, listing]);
  const window = kind === 'drop' ? 600 : 86400;
  return db.prepare(`
    INSERT INTO recent_alerts VALUES (?, ?, ?)
    ON CONFLICT(user_id, fingerprint) DO UPDATE SET notified_at = excluded.notified_at WHERE notified_at <= ?
  `).run(userId, fingerprint, now, now - window).changes === 1;
}
