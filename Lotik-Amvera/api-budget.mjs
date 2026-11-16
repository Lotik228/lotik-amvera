import { transaction } from './store.mjs';

export const creditsPerAvitoCall = 5;
const zone = Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' });

export function apiBudgetStatus(db, config, time = Date.now()) {
  const day = zone.format(time);
  const used = db.prepare('SELECT credits FROM api_budget WHERE period = ?');
  return {
    today: used.get(day)?.credits ?? 0, daily: config.apiDailyCredits,
    month: used.get(day.slice(0, 7))?.credits ?? 0, monthly: config.apiMonthlyCredits,
  };
}

export function budgetedFetch(db, config, fetchData = fetch, now = Date.now) {
  const used = db.prepare('SELECT credits FROM api_budget WHERE period = ?');
  const increment = db.prepare(`
    INSERT INTO api_budget VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET credits = credits + excluded.credits
  `);
  const pause = db.prepare(`
    INSERT INTO api_budget VALUES ('pause', ?) ON CONFLICT(period) DO UPDATE SET credits = MAX(credits, excluded.credits)
  `);
  return async (url, options) => {
    if (new URL(url).origin !== 'https://api.api.sh') return fetchData(url, options);
    const time = now();
    const day = zone.format(time);
    const month = day.slice(0, 7);
    transaction(db, () => {
      if ((used.get('pause')?.credits ?? 0) > time) throw new Error('API.SH временно приостановлен');
      if ((used.get(day)?.credits ?? 0) + creditsPerAvitoCall > config.apiDailyCredits
        || (used.get(month)?.credits ?? 0) + creditsPerAvitoCall > config.apiMonthlyCredits) {
        throw new Error('Лимит расходов API.SH исчерпан');
      }
      increment.run(day, creditsPerAvitoCall);
      increment.run(month, creditsPerAvitoCall);
    });
    const response = await fetchData(url, options);
    if (response.status === 402) {
      const nextMoscowDay = (Math.floor((time + 10800000) / 86400000) + 1) * 86400000 - 10800000;
      pause.run(nextMoscowDay);
    } else if (response.status === 429) {
      const hint = response.headers.get('retry-after');
      const seconds = hint && /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - time;
      pause.run(time + Math.min(Math.max(Number.isFinite(seconds) ? seconds : 60000, 1000), 86400000));
    }
    return response;
  };
}
