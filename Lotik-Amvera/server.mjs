import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { openStore, cardAccess } from './store.mjs';
import { readConfig } from './config.mjs';
import { refreshFeed } from './feed.mjs';
import { telegramClient, verifyInitData } from './telegram.mjs';
import { handleBotUpdate } from './bot.mjs';
import { createLookup, hasLookup, startWatchWorker } from './watch-worker.mjs';
import { createMarketSearch, marketCities } from './market-search.mjs';
import { apiBudgetStatus, budgetedFetch } from './api-budget.mjs';
import { createSearchLookup, createSearchWorker, deleteSearch, linkSourceState, listSavedSearches, resolveWatchLink, saveSearch } from './saved-searches.mjs';
import { addWatches, listWatches, plans, readTrackingName, removeWatch, userPlan, userPlanKey, watchStatus } from './watches.mjs';
import { endSession, getAccount, signIn, startSession } from './accounts.mjs';
import { checkout, createYooKassaClient, handlePaymentWebhook, paymentState, reconcileLatestPayment } from './payments.mjs';
import { changeOwnerPlan, ownerOverview, ownerUser } from './owner.mjs';
import { runParser } from './parser-loop.mjs';
import { claimParserJob, finishParserJob, initializeParserStorage } from './parser-jobs.mjs';

const FREE_LIMIT = 3;
const config = readConfig();
const db = openStore(config.dataDir);
const embeddedParser = process.env.LOTIK_EMBEDDED_PARSER === '1' && config.parserMode !== 'off';
if (embeddedParser) initializeParserStorage(db, config.parserMode);
const telegram = telegramClient(config.token, config.telegramTest);
const cardApi = config.shopId && createYooKassaClient(config);
const testPayments = config.paymentTest;
const findTelegramUser = db.prepare('SELECT 1 FROM users WHERE id = ?');
const saveTelegramUser = db.prepare(`
  INSERT INTO users (id, name, username) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username
  WHERE users.name IS NOT excluded.name OR users.username IS NOT excluded.username
`);
const authAttempts = new Map();
const apiFetch = budgetedFetch(db, config);
const marketSearch = config.searchKey ? createMarketSearch(config.searchKey, apiFetch) : null;
const searchLookup = config.searchKey ? createSearchLookup(config.searchKey, apiFetch) : null;
const watchLookup = hasLookup(config) ? createLookup(config, apiFetch) : null;
if (watchLookup || searchLookup || config.parserMode === 'live') {
  startWatchWorker(db, watchLookup, telegram, searchLookup ? createSearchWorker(db, searchLookup) : null,
    { textSearches: Boolean(searchLookup), linkSearches: config.parserMode === 'live' });
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/web/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/lotik-logo.jpg', ['lotik-logo.jpg', 'image/jpeg']],
]);

if (config.feedUrl) {
  let refreshing = false;
  const sync = async () => {
    if (refreshing) return;
    refreshing = true;
    try { await refreshFeed(config, db); } catch {
      console.error('Не удалось обновить источник объявлений. Сохранена предыдущая лента.');
    } finally { refreshing = false; }
  };
  void sync();
  setInterval(sync, config.feedInterval * 1000).unref();
}

function feedState() {
  return db.prepare('SELECT refreshed_at FROM feed_meta WHERE id = 1').get()?.refreshed_at ?? null;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256_000) throw Object.assign(new Error(), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error(), { status: 400 });
  }
}

function matchesSecret(value, secret) {
  return typeof secret === 'string' && typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(secret)
    && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
}

function canCheckout() {
  return Boolean(config.cardCheckoutEnabled && cardApi && (marketSearch || (config.feedUrl && feedState())));
}

function searchProfile() {
  return {
    searchMode: marketSearch ? 'market' : config.feedUrl ? 'snapshot' : 'external',
    searchCities: marketCities,
  };
}

function checkAuthRate(req, now) {
  const key = req.socket.remoteAddress;
  for (const [address, value] of authAttempts) if (value.until <= now) authAttempts.delete(address);
  const entry = authAttempts.get(key) ?? { count: 0, until: now + 60 };
  if (entry.count >= 30) return false;
  entry.count++;
  authAttempts.set(key, entry);
  return true;
}

function webProfile(account, now) {
  const access = account && cardAccess(db, account.id, now, testPayments);
  return {
    name: account?.email, signedIn: Boolean(account), price: config.price, support: config.support,
    expiresAt: access?.expires_at ?? null, canSubscribe: canCheckout() && Boolean(account),
    testPayments, paymentState: account ? paymentState(db, account.id, now, testPayments) : null,
    canCheckPayment: Boolean(account && cardApi), webPreviewLimit: FREE_LIMIT,
    trackingHelpVideoUrl: config.trackingHelpVideoUrl, ...searchProfile(),
  };
}

async function watchRoute(req, res, url, id, now) {
  const enabled = Boolean(watchLookup);
  if (req.method === 'GET') {
    const page = Math.max(1, Math.min(100000, parseInt(url.searchParams.get('page'), 10) || 1));
    const { rows, hasNext } = listWatches(db, id, page);
    return json(res, 200, {
      plan: userPlan(db, id), enabled, hasNext, now,
      total: db.prepare('SELECT COUNT(*) AS total FROM watches WHERE user_id = ?').get(id).total,
      rows: rows.map(row => ({
        id: row.listing_id, url: row.url, dueAt: row.due_at, checkedAt: row.checked_at,
        title: row.last_title, name: row.tracking_name, status: watchStatus(row),
      })),
    });
  }
  if (req.method === 'POST') {
    const input = await body(req);
    const link = resolveWatchLink(input?.url);
    if (link.kind === 'search') {
      const search = saveSearch(db, id, { sourceUrl: link.url, name: input.name, newEnabled: true, dropEnabled: false }, now, { allowSaveOnly: true });
      return json(res, 200, { kind: 'search', ...search, sourceState: linkSourceState(db, config.parserMode === 'live') });
    }
    if (!enabled) return json(res, 409, { error: 'Объявление не добавлено. Проверка отдельных объявлений недоступна без источника.' });
    const added = addWatches(db, id, [{ ...link, name: readTrackingName(input.name) }], now) === 1;
    return json(res, 200, { added });
  }
  if (req.method === 'DELETE') {
    const input = await body(req);
    if (removeWatch(db, id, input?.id) !== true) return json(res, 404, { error: 'Объявление уже снято с отслеживания.' });
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Действие недоступно.' });
}

async function searchWatchRoute(req, res, id, now) {
  const enabled = Boolean(searchLookup);
  const linkEnabled = config.parserMode === 'live';
  if (req.method === 'GET') return json(res, 200, {
    enabled, linkEnabled,
    parserPaused: linkSourceState(db, linkEnabled) === 'paused',
    plan: userPlan(db, id), cities: marketCities, rows: listSavedSearches(db, id),
  });
  const input = await body(req);
  if (req.method === 'POST' || req.method === 'PUT') {
    if (req.method === 'PUT' && !Number.isSafeInteger(input?.id)) return json(res, 400, { error: 'Укажите сохранённый поиск.' });
    const search = saveSearch(db, id, input, now, { allowSaveOnly: req.method === 'POST' && input?.sourceUrl != null });
    const sourceState = search.sourceUrl ? linkSourceState(db, linkEnabled) : enabled ? 'ready' : 'off';
    return json(res, 200, { ok: true, ...search, sourceState });
  }
  if (req.method === 'DELETE') {
    if (!Number.isSafeInteger(input?.id)) return json(res, 400, { error: 'Укажите сохранённый поиск.' });
    if (!deleteSearch(db, id, input.id)) return json(res, 404, { error: 'Поиск не найден.' });
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Действие недоступно.' });
}

function listings(userId, hasPro, params) {
  const query = (params.get('q') ?? '').trim().toLocaleLowerCase('ru').slice(0, 100);
  const city = params.get('city') ?? '';
  const category = params.get('category') ?? '';
  const max = params.get('max');
  const savedOnly = params.get('saved') === '1';
  const page = Math.max(0, Math.min(1000, parseInt(params.get('page'), 10) || 0));
  const sort = params.get('sort') === 'price' ? 'price ASC, posted_at DESC' : 'posted_at DESC';
  const source = savedOnly ? `(
    SELECT id, title, city, category, price, url, posted_at FROM market_listings
    UNION ALL SELECT * FROM listings WHERE NOT EXISTS (SELECT 1 FROM market_listings WHERE market_listings.id = listings.id)
  )` : 'listings';
  const list = db.prepare(`
    SELECT listings.*, favorites.ad_id IS NOT NULL AS saved
    FROM ${source} AS listings LEFT JOIN favorites ON favorites.ad_id = listings.id AND favorites.user_id = ?
    WHERE length(listings.id) >= 5
    ORDER BY ${sort}, listings.id
  `).all(userId);
  const filtered = list.filter(ad =>
    (!query || ad.title.toLocaleLowerCase('ru').includes(query)) &&
    (!city || ad.city === city) && (!category || ad.category === category) &&
    (!max || ad.price <= Number(max)) && (!savedOnly || ad.saved));
  const limit = hasPro || savedOnly ? 20 : FREE_LIMIT;
  const offset = hasPro || savedOnly ? page * limit : 0;
  return {
    total: filtered.length, rows: filtered.slice(offset, offset + limit),
    cities: [...new Set(list.map(ad => ad.city))].sort((a, b) => a.localeCompare(b, 'ru')),
    categories: [...new Set(list.map(ad => ad.category))].sort((a, b) => a.localeCompare(b, 'ru')),
    limited: !hasPro && !savedOnly && filtered.length > limit,
    hasNext: (hasPro || savedOnly) && filtered.length > offset + limit,
    lastSync: feedState(),
  };
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, 'http://localhost');
  const web = url.pathname === '/web' || url.pathname.startsWith('/web/');
  const route = web ? url.pathname.slice(4) : url.pathname;
  const sdk = web ? '' : ' https://telegram.org';
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'" + sdk + "; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" + (web ? "; frame-ancestors 'none'" : ''));
  const now = Math.floor(Date.now() / 1000);
  try {
    if (req.method === 'GET' && url.pathname === '/web') {
      res.writeHead(308, { Location: '/web/' + url.search });
      return res.end();
    }
    const asset = assets.get(url.pathname);
    if (req.method === 'GET' && asset) {
      const [file, type] = asset;
      let content = await readFile(new URL('./public/' + file, import.meta.url));
      if (file === 'index.html') {
        content = content.toString('utf8').replace('<!-- telegram-sdk -->', web ? '' : '<script src="https://telegram.org/js/telegram-web-app.js" defer></script>')
          .replace('<body>', '<body class="' + (web ? 'web' : 'mini') + '">');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(content);
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (!matchesSecret(req.headers['x-telegram-bot-api-secret-token'], config.secret)) {
        return json(res, 403, { error: 'Доступ закрыт.' });
      }
      await handleBotUpdate(db, telegram, config, await body(req), now);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/payments/yookassa/')) {
      if (!cardApi || !matchesSecret(url.pathname.slice('/payments/yookassa/'.length), config.paymentSecret)) {
        return json(res, 403, { error: 'Доступ закрыт.' });
      }
      await handlePaymentWebhook(db, cardApi, await body(req));
      return json(res, 200, { ok: true });
    }
    if (!route.startsWith('/api/')) return json(res, 404, { error: 'Страница не найдена.' });
    if (web && req.method !== 'GET') {
      if (req.headers.origin !== config.webUrl) return json(res, 403, { error: 'Откройте сайт напрямую.' });
    }
    let account;
    if (web) {
      account = getAccount(db, req, now);
      if (req.method === 'POST' && ['/api/register', '/api/login'].includes(route)) {
        if (!checkAuthRate(req, now)) return json(res, 429, { error: 'Слишком много попыток. Попробуйте через минуту.' });
        const accountId = await signIn(db, await body(req), route === '/api/register');
        startSession(db, req, res, accountId, now, true);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/logout') {
        endSession(db, req, res, true);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/api/me') return json(res, 200, webProfile(account, now));
      if (!account) {
        return json(res, 401, { error: 'Войдите в личный кабинет.' });
      }
    }
    const user = web ? { id: -account.id } : verifyInitData(req.headers['x-telegram-init-data'], config.token, now);
    if (!user) return json(res, 401, { error: 'Откройте приложение заново из меню Telegram.' });
    const name = web ? account.email : [user.first_name, user.last_name].filter(Boolean).join(' ');
    const username = user.username ?? null;
    if (!web && (route === '/api/me' || !findTelegramUser.get(user.id))) {
      saveTelegramUser.run(user.id, name, username);
    }
    if (req.method === 'POST' && route === '/api/watches/resolve') {
      return json(res, 200, { ...resolveWatchLink((await body(req))?.url), listingEnabled: Boolean(watchLookup) });
    }
    if (route === '/api/watches') return await watchRoute(req, res, url, user.id, now);
    if (route === '/api/search-watches') return await searchWatchRoute(req, res, user.id, now);
    const isOwner = !web && user.id === config.owner;
    const active = web && cardAccess(db, account.id, now, testPayments);
    const hasPro = Boolean(active);

    if (req.method === 'GET' && route === '/api/me') {
      const monitoringPlanKey = userPlanKey(db, user.id);
      return json(res, 200, {
        name, username, telegramId: user.id, isOwner, support: config.support,
        monitoringPlan: plans[monitoringPlanKey], monitoringPlanKey, monitoringPlans: plans,
        trackingHelpVideoUrl: config.trackingHelpVideoUrl, ...searchProfile(),
      });
    }
    if (req.method === 'GET' && route === '/api/feed') {
      if (marketSearch && url.searchParams.get('saved') !== '1') {
        try {
          return json(res, 200, await marketSearch(db, user.id, hasPro, url.searchParams));
        } catch {
          return json(res, 502, { error: 'Выдача Авито сейчас недоступна. Откройте поиск на Авито.' });
        }
      }
      return json(res, 200, listings(user.id, hasPro, url.searchParams));
    }
    if (req.method === 'PUT' && route === '/api/favorite') {
      const input = await body(req);
      if (typeof input?.id !== 'string' || !/^\d{5,32}$/.test(input.id) || typeof input.saved !== 'boolean') {
        return json(res, 400, { error: 'Некорректное объявление.' });
      }
      if (input.saved) {
        if (!db.prepare('SELECT id FROM listings WHERE id = ? UNION ALL SELECT id FROM market_listings WHERE id = ?')
          .get(input.id, input.id)) return json(res, 404, { error: 'Объявление снято.' });
        db.prepare('INSERT OR IGNORE INTO favorites VALUES (?, ?)').run(user.id, input.id);
      } else {
        db.prepare('DELETE FROM favorites WHERE user_id = ? AND ad_id = ?').run(user.id, input.id);
      }
      return json(res, 200, { saved: input.saved });
    }
    if (req.method === 'POST' && web && route === '/api/subscribe') {
      if (!canCheckout()) return json(res, 409, { error: 'Оплата пока недоступна.' });
      if (active) return json(res, 409, { error: 'Подписка уже активна.' });
      return json(res, 200, await checkout(db, config, cardApi, account, now));
    }
    if (req.method === 'POST' && web && route === '/api/payment-status') {
      if (cardApi) await reconcileLatestPayment(db, cardApi, account.id, testPayments);
      return json(res, 200, webProfile(account, now));
    }
    if (req.method === 'GET' && route === '/api/owner') {
      if (!isOwner) return json(res, 403, { error: 'Доступ только владельцу.' });
      return json(res, 200, {
        ...ownerOverview(db, now),
        liveFeed: Boolean(config.feedUrl), lastSync: feedState(),
        budget: apiBudgetStatus(db, config),
      });
    }
    if (route === '/api/owner/user') {
      if (!isOwner) return json(res, 403, { error: 'Доступ только владельцу.' });
      if (req.method === 'GET') return json(res, 200, ownerUser(db, url.searchParams.get('q')));
      if (req.method === 'POST') return json(res, 200, changeOwnerPlan(db, user.id, await body(req), now));
    }
    return json(res, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    const status = error.status ?? 500;
    if (status >= 500) console.error('Request failed:', error.message);
    return json(res, status, { error: status >= 500 ? 'Операция временно недоступна. Попробуйте ещё раз.' : error.message || 'Некорректный запрос.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log('Лотик · http://127.0.0.1:' + server.address().port);
  if (!embeddedParser) return;
  const now = () => Math.floor(Date.now() / 1000);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopping = true;
    server.close();
  });
  void runParser({
    mode: config.parserMode,
    stopping: () => stopping,
    claim: () => claimParserJob(db, now(), config.parserGap),
    finish: ({ token, result }) => finishParserJob(db, token, result, now()),
  });
});
