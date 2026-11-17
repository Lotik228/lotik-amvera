import { posix } from 'node:path';
import { readParserConfig } from './parser-config.mjs';

export function readConfig(env = process.env) {
  if (env.MODE && env.MODE !== 'production') throw new Error('Use MODE=production for Lotik');
  const parser = readParserConfig({ ...env, MODE: 'production' });
  const config = {
    port: Number(env.PORT || 3000),
    host: '0.0.0.0',
    parserMode: parser.mode,
    parserGap: parser.gap,
    token: env.BOT_TOKEN,
    telegramTest: env.TELEGRAM_TEST === '1',
    secret: env.WEBHOOK_SECRET,
    owner: Number(env.OWNER_TELEGRAM_ID),
    support: env.SUPPORT_CONTACT?.trim(),
    trackingHelpVideoUrl: telegramPostUrl(env.TRACKING_HELP_VIDEO_URL),
    price: Number(env.CARD_PRICE_RUB || 299),
    shopId: env.YOOKASSA_SHOP_ID?.trim(),
    shopKey: env.YOOKASSA_SECRET_KEY?.trim(),
    paymentTest: env.YOOKASSA_TEST === '1',
    paymentSecret: env.PAYMENT_WEBHOOK_SECRET,
    receiptVat: env.YOOKASSA_RECEIPT_VAT_CODE ? Number(env.YOOKASSA_RECEIPT_VAT_CODE) : null,
    dataDir: env.DATA_DIR || (env.AMVERA === '1' ? '/data' : './data'),
    feedToken: env.LISTINGS_FEED_TOKEN,
    feedInterval: Number(env.FEED_INTERVAL_SECONDS || 300),
    watchToken: env.WATCH_LOOKUP_TOKEN,
    watchApiKey: env.AVITO_WATCH_API_KEY?.trim(),
    searchKey: env.AVITO_SEARCH_API_KEY?.trim(),
    apiDailyCredits: Number(env.AVITO_API_DAILY_CREDITS ?? 500),
    apiMonthlyCredits: Number(env.AVITO_API_MONTHLY_CREDITS ?? 10000),
    cardCheckoutEnabled: env.ENABLE_CARD_CHECKOUT === '1' && env.YOOKASSA_TEST === '1'
      && env.AMVERA !== '1' && env.LOTIK_CONTAINER !== '1',
  };
  if (env.AMVERA === '1') {
    const mountedPath = posix.resolve('/', config.dataDir);
    if (!posix.isAbsolute(config.dataDir) || (mountedPath !== '/data' && !mountedPath.startsWith('/data/'))) {
      throw new Error('DATA_DIR must be on the Amvera /data volume');
    }
  }
  for (const limit of [config.apiDailyCredits, config.apiMonthlyCredits]) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('API.SH credit limits must be non-negative integers');
  }
  if (!Number.isInteger(config.price) || config.price < 1 || config.price > 100000) throw new Error('Invalid CARD_PRICE_RUB');
  if (config.receiptVat !== null && (!Number.isInteger(config.receiptVat) || config.receiptVat < 1)) throw new Error('Invalid YOOKASSA_RECEIPT_VAT_CODE');
  if (!Number.isInteger(config.feedInterval) || config.feedInterval < 60 || config.feedInterval > 86400) throw new Error('Invalid FEED_INTERVAL_SECONDS');
  if (env.LISTINGS_FEED_URL) config.feedUrl = httpsUrl(env.LISTINGS_FEED_URL, 'LISTINGS_FEED_URL');
  if (env.WATCH_LOOKUP_URL) config.watchUrl = httpsUrl(env.WATCH_LOOKUP_URL, 'WATCH_LOOKUP_URL');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.token ?? '')) throw new Error('Set a valid BOT_TOKEN');
  if (!config.support) throw new Error('Set SUPPORT_CONTACT');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.secret ?? '')) throw new Error('Set a random WEBHOOK_SECRET (32–256 characters)');
  if (!Number.isSafeInteger(config.owner) || config.owner <= 0) throw new Error('Set OWNER_TELEGRAM_ID');
  config.publicUrl = httpsUrl(env.PUBLIC_URL, 'PUBLIC_URL').origin;
  config.webUrl = env.WEB_PUBLIC_URL ? httpsUrl(env.WEB_PUBLIC_URL, 'WEB_PUBLIC_URL').origin : config.publicUrl;
  if (config.shopId || config.shopKey) {
    if (!/^\d+$/.test(config.shopId ?? '') || !config.shopKey
      || !/^[A-Za-z0-9_-]{32,128}$/.test(config.paymentSecret ?? '')) throw new Error('Configure the YooKassa shop and webhook secret');
  }
  return config;
}

function telegramPostUrl(value) {
  const candidate = value?.trim();
  return /^https:\/\/t\.me\/(?:[a-z][a-z0-9_]{4,31}|c\/[1-9]\d*)\/[1-9]\d*$/i.test(candidate ?? '') ? candidate : null;
}

function httpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set a valid ' + name); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(name + ' must use HTTPS');
  return url;
}
