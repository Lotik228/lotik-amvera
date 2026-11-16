import { randomUUID } from 'node:crypto';
import { transaction } from './store.mjs';

export const ACCESS_SECONDS = 30 * 86400;
const RETRY_SECONDS = 23 * 3600;
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const money = value => (value / 100).toFixed(2);

export function createYooKassaClient(config) {
  const authorization = 'Basic ' + Buffer.from(config.shopId + ':' + config.shopKey).toString('base64');
  return async (path, payload, key) => {
    const response = await fetch('https://api.yookassa.ru/v3/' + path, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: authorization,
        ...(payload && { 'Content-Type': 'application/json', 'Idempotence-Key': key }) },
      body: payload && JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('YooKassa API returned ' + response.status);
    return response.json();
  };
}

export function pendingOrder(db, accountId, testMode) {
  return db.prepare(`
    SELECT * FROM card_orders WHERE account_id = ? AND status = 'pending' AND is_test = ? ORDER BY created_at DESC LIMIT 1
  `).get(accountId, Number(testMode));
}

function latestOrder(db, accountId, testMode) {
  return db.prepare(`
    SELECT id, payment_id, status, amount_minor, created_at,
      COALESCE((SELECT SUM(amount_minor) FROM card_refunds WHERE order_id = card_orders.id), 0) AS refunded_minor
    FROM card_orders WHERE account_id = ? AND is_test = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(accountId, Number(testMode));
}

export function paymentState(db, accountId, now, testMode) {
  const order = latestOrder(db, accountId, testMode);
  if (!order) return null;
  if (order.status === 'pending' && !order.payment_id) {
    return now - order.created_at >= RETRY_SECONDS ? 'unconfirmed' : 'not_started';
  }
  if (order.refunded_minor >= order.amount_minor) return 'refunded';
  if (order.refunded_minor > 0) return 'partially_refunded';
  return order.status;
}

function newOrder(db, config, account, now) {
  const id = randomUUID();
  const amount = { value: money(config.price * 100), currency: 'RUB' };
  const description = 'Лотик Pro · веб-доступ на 30 дней';
  const payload = {
    amount, capture: true, description, payment_method_data: { type: 'bank_card' },
    confirmation: { type: 'redirect', return_url: config.webUrl + '/web/?payment=return' },
    metadata: { radar_order: id },
  };
  if (config.receiptVat !== null) {
    payload.receipt = {
      customer: { email: account.email },
      items: [{ description, quantity: '1.00', amount, vat_code: config.receiptVat,
        payment_mode: 'full_payment', payment_subject: 'service' }],
    };
  }
  db.prepare(`
    INSERT INTO card_orders (id, account_id, amount_minor, created_at, attempt_json, is_test)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, account.id, config.price * 100, now, JSON.stringify(payload), Number(config.paymentTest));
  return pendingOrder(db, account.id, config.paymentTest);
}

export function applyPayment(db, payment) {
  const id = payment?.metadata?.radar_order;
  if (typeof id !== 'string' || !idPattern.test(id) || typeof payment.id !== 'string' || !idPattern.test(payment.id)) return null;
  return transaction(db, () => {
    const order = db.prepare('SELECT * FROM card_orders WHERE id = ?').get(id);
    if (!order || (order.payment_id && order.payment_id !== payment.id)
      || payment.amount?.currency !== 'RUB' || payment.amount.value !== money(order.amount_minor)
      || payment.test !== Boolean(order.is_test)
      || ((payment.status === 'succeeded' || payment.payment_method != null) && payment.payment_method?.type !== 'bank_card')
      || !['pending', 'succeeded', 'canceled'].includes(payment.status)) return null;
    if (order.status !== 'pending') return order;

    let paidAt = null;
    if (payment.status === 'succeeded') {
      paidAt = Math.floor(Date.parse(payment.captured_at) / 1000);
      if (!payment.paid || !Number.isSafeInteger(paidAt) || paidAt < order.created_at - 120) return null;
    }
    db.prepare('UPDATE card_orders SET payment_id = ?, status = ?, paid_at = ?, expires_at = ? WHERE id = ?')
      .run(payment.id, payment.status, paidAt, paidAt && paidAt + ACCESS_SECONDS, id);
    return db.prepare('SELECT * FROM card_orders WHERE id = ?').get(id);
  });
}

function recordRefund(db, order, refund) {
  if (order?.status !== 'succeeded' || typeof refund?.id !== 'string' || !idPattern.test(refund.id)
    || refund.payment_id !== order.payment_id || refund.status !== 'succeeded'
    || refund.amount?.currency !== 'RUB' || !/^\d+\.\d{2}$/.test(refund.amount.value)) return;
  const amount = Math.round(Number(refund.amount.value) * 100);
  if (amount <= 0 || amount > order.amount_minor) return;
  db.prepare(`
    INSERT OR IGNORE INTO card_refunds (refund_id, order_id, amount_minor)
    SELECT ?, ?, ?
    WHERE ? + COALESCE((SELECT SUM(amount_minor) FROM card_refunds WHERE order_id = ?), 0) <= ?
  `).run(refund.id, order.id, amount, amount, order.id, order.amount_minor);
}

export async function reconcileLatestPayment(db, call, accountId, testMode) {
  const order = latestOrder(db, accountId, testMode);
  if (!order?.payment_id || order.status === 'canceled' || order.refunded_minor >= order.amount_minor) return;
  const payment = await call('payments/' + order.payment_id);
  if (payment?.id !== order.payment_id || payment.metadata?.radar_order !== order.id) {
    throw new Error('YooKassa payment does not match the order');
  }
  const saved = applyPayment(db, payment);
  if (!saved) throw new Error('YooKassa payment does not match the order');
  if (saved.status !== 'succeeded' || payment.status !== 'succeeded') return;

  const query = new URLSearchParams({ payment_id: order.payment_id, status: 'succeeded', limit: '100' });
  const cursors = new Set();
  do {
    const page = await call('refunds?' + query);
    if (!Array.isArray(page?.items)) throw new Error('YooKassa returned an invalid refund list');
    transaction(db, () => {
      for (const refund of page.items) recordRefund(db, saved, refund);
    });
    if (!page.next_cursor) return;
    if (typeof page.next_cursor !== 'string' || cursors.has(page.next_cursor)) {
      throw new Error('YooKassa returned an invalid refund cursor');
    }
    cursors.add(page.next_cursor);
    query.set('cursor', page.next_cursor);
  } while (true);
}

export async function checkout(db, config, call, account, now) {
  const order = pendingOrder(db, account.id, config.paymentTest) ?? newOrder(db, config, account, now);
  if (!order.payment_id && now - order.created_at >= RETRY_SECONDS) {
    throw Object.assign(new Error('Статус предыдущей оплаты требует проверки. Свяжитесь с поддержкой.'), { status: 409 });
  }
  const payment = order.payment_id
    ? await call('payments/' + order.payment_id)
    : await call('payments', JSON.parse(order.attempt_json), order.id);
  const saved = applyPayment(db, payment);
  if (!saved || saved.id !== order.id) throw new Error('YooKassa payment does not match the order');
  if (saved.status === 'succeeded') return { paid: true };
  if (saved.status === 'canceled') return { canceled: true };
  const confirmation = new URL(payment.confirmation?.confirmation_url);
  if (confirmation.protocol !== 'https:' || confirmation.username || confirmation.password
    || !['yoomoney.ru', 'yookassa.ru'].some(domain => confirmation.hostname === domain || confirmation.hostname.endsWith('.' + domain))) {
    throw new Error('Unexpected card confirmation URL');
  }
  return { checkoutUrl: confirmation.href };
}

export async function handlePaymentWebhook(db, call, event) {
  const id = event?.object?.id;
  if (typeof id !== 'string' || !idPattern.test(id)) return;
  if (['payment.succeeded', 'payment.canceled'].includes(event.event)) {
    const payment = await call('payments/' + id);
    if (payment?.id === id) applyPayment(db, payment);
  }
  if (event.event === 'refund.succeeded') {
    const refund = await call('refunds/' + id);
    const paymentId = refund?.payment_id;
    if (refund?.id !== id || refund.status !== 'succeeded' || typeof paymentId !== 'string' || !idPattern.test(paymentId)) return;
    let order = db.prepare('SELECT * FROM card_orders WHERE payment_id = ?').get(paymentId);
    if (!order) {
      const payment = await call('payments/' + paymentId);
      if (payment?.id === paymentId) order = applyPayment(db, payment);
    }
    recordRefund(db, order, refund);
  }
}
