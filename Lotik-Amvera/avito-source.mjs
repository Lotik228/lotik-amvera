import { parseSearchUrl } from './saved-searches.mjs';

const hosts = new Set(['avito.ru', 'www.avito.ru', 'm.avito.ru']);
const avito = 'https://www.avito.ru';

function avitoUrl(input, base) {
  const url = new URL(input, base);
  if (url.protocol !== 'https:' || !hosts.has(url.host) || url.username || url.password) {
    throw new Error('Требуется HTTPS-ссылка на avito.ru.');
  }
  return url;
}

function entities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (source, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? source;
    const code = key[1].toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : source;
  });
}

function text(value) {
  return entities(String(value ?? '')).replace(/\s+/gu, ' ').trim();
}

function readPrice(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 && raw <= 1e12 ? raw : null;
  if (typeof raw !== 'string') return null;
  const value = text(raw).replace(/\s|₽/gu, '');
  if (!/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}

// Search-state traversal and field mapping adapted from Grovvik/avito-deal-parser.
// Copyright (c) 2026 Grovvik. See LICENSE.Grovvik.txt (MIT).
function normalizeItem(raw, base) {
  const hinted = raw.id ?? raw.itemId;
  const rawUrl = raw.urlPath ?? raw.url ?? raw.absoluteUrl ?? raw.link ?? raw.uri;
  if (typeof rawUrl !== 'string') return null;
  let url;
  try { url = avitoUrl(rawUrl, base); } catch { return null; }
  const id = url.pathname.match(/_(\d{5,32})\/?$/)?.[1] ?? url.pathname.match(/^\/(?:i|items)\/(\d{5,32})\/?$/)?.[1];
  if (!id || (hinted != null && String(hinted) !== id)) return null;
  const title = text(raw.title);
  if (!title) return null;
  const price = readPrice(raw.priceDetailed?.value ?? raw.price?.current ?? raw.price?.value ?? raw.price);
  return { id, title: title.slice(0, 250), price, url: url.origin + url.pathname };
}

function stateItems(state, base) {
  const root = state?.search ?? state?.state?.loaderData?.search ?? state?.loaderData?.search;
  if (!root || typeof root !== 'object') return [];
  const cards = new Map();
  const nodes = [root];
  for (let i = 0; i < nodes.length && i < 50000; i++) {
    const node = nodes[i];
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const value of node) {
        const raw = value?.value ?? value;
        if (raw && typeof raw === 'object' && (raw.id != null || raw.itemId != null) && typeof raw.title === 'string') {
          const card = normalizeItem(raw, base);
          if (card) cards.set(card.id, card);
        }
      }
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') nodes.push(child);
  }
  return [...cards.values()];
}

function attribute(tag, name) {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const match = tag.match(pattern);
  return match ? entities(match[1] ?? match[2] ?? match[3]) : null;
}

export function extractListings(html, base = avito) {
  const cards = new Map();
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attribute(script[1], 'data-mfe-state') !== 'true') continue;
    let data;
    try { data = JSON.parse(script[2]); } catch { continue; }
    for (const card of stateItems(data, base)) cards.set(card.id, card);
  }
  if (cards.size) return { source: 'embedded-json', listings: [...cards.values()] };

  const starts = [...html.matchAll(/<(?:div|article|li)\b([^>]*)>/gi)]
    .filter(match => attribute(match[1], 'data-marker') === 'item' && /^\d{5,32}$/.test(attribute(match[1], 'data-item-id') ?? ''));
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const segment = html.slice(start.index, Math.min(starts[index + 1]?.index ?? html.length, start.index + 100000));
    const anchor = [...segment.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
      .find(match => attribute(match[1], 'data-marker') === 'item-title');
    if (!anchor) continue;
    const meta = [...segment.matchAll(/<meta\b([^>]*)>/gi)].find(match => attribute(match[1], 'itemprop') === 'price');
    const card = normalizeItem({
      id: attribute(start[1], 'data-item-id'), url: attribute(anchor[1], 'href'),
      title: anchor[2].replace(/<[^>]*>/g, ' '), price: meta ? attribute(meta[1], 'content') : null,
    }, base);
    if (card) cards.set(card.id, card);
  }
  return { source: cards.size ? 'html' : null, listings: [...cards.values()] };
}

const blockedStatuses = new Set([401, 403, 429, 439, 451]);
const maxBodyBytes = 4 * 1024 * 1024;

function isChallenge(html) {
  const title = text(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]);
  return /captcha|доступ ограничен|слишком много запросов|проверка браузера|access denied/i.test(title)
    || /<(?:form|fieldset|iframe|input)\b[^>]*(?:captcha|challenge-platform)/i.test(html)
    || /(?:докажите, что вы не робот|введите код с картинки|подтвердите, что вы человек)/i.test(html);
}

function retryAt(value) {
  if (!value) return 0;
  const time = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  const seconds = Math.ceil(time / 1000);
  return Number.isSafeInteger(seconds) ? Math.max(0, seconds) : 0;
}

export async function fetchAvitoSearch(value, fetchPage = fetch) {
  const url = parseSearchUrl(value);
  if (!url) return { kind: 'error', reason: 'invalid_url' };
  const response = await fetchPage(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'LotikMonitor/1.0' },
    signal: AbortSignal.timeout(12000), redirect: 'manual',
  });
  const status = response.status;
  const location = response.headers.get('location') || '';
  const next = retryAt(response.headers.get('retry-after'));
  if (blockedStatuses.has(status) || /captcha|challenge|firewall/i.test(location)) {
    await response.body?.cancel();
    return { kind: 'blocked', status, reason: 'access_restricted', retryAt: next };
  }
  if (status !== 200 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    return { kind: 'error', status, reason: 'unexpected_response', retryAt: next };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBodyBytes) return { kind: 'error', status, reason: 'body_too_large' };
    chunks.push(chunk);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  if (isChallenge(html)) return { kind: 'blocked', status, reason: 'captcha', retryAt: next };
  const { listings } = extractListings(html, url);
  if (!listings.length && !/data-marker\s*=\s*["']catalog-serp\/no-results["']/i.test(html)) {
    return { kind: 'error', status, reason: 'unrecognized_page' };
  }
  return { kind: 'ok', status, rows: listings.slice(0, 100) };
}


