import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { signIn } from './accounts.mjs';
import { ACCESS_SECONDS, checkout, handlePaymentWebhook } from './payments.mjs';
import { normalizeFeed, saveFeed } from './feed.mjs';
import { cardAccess, openStore } from './store.mjs';
import { verifyInitData } from './telegram.mjs';

test('Telegram login requires a valid fresh signature and rejects modified identities', () => {
  const now = 1_700_000_000;
  const token = '123456:secret_token';
  const data = new URLSearchParams({ user: '{"first_name":"Тест","id":42}', auth_date: String(now) });
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', key).update('auth_date=' + now + '\nuser=' + data.get('user')).digest('hex');
  data.set('hash', hash);
  assert.equal(verifyInitData(data.toString(), token, now)?.id, 42);
  assert.equal(verifyInitData(data.toString(), token, now + 3601), null);
  data.set('user', '{"first_name":"Тест","id":15}');
  assert.equal(verifyInitData(data.toString(), token, now), null);
});

test('feed keeps canonical Avito links and deduplicates by Avito ID', () => {
  const db = openStore(':memory:');
  const row = { title: 'Кресло', city: 'Москва', category: 'Для дома', price: 100,
    url: 'https://www.avito.ru/moskva/kreslo_1234567?utm_source=example', postedAt: '2026-11-15T10:00:00+03:00' };
  const entries = normalizeFeed({ listings: [row, { ...row, price: 200 }] });
  saveFeed(db, entries, 1000);
  assert.equal(entries.length, 1);
  assert.equal(db.prepare('SELECT price FROM listings').get().price, 200);
  assert.equal(entries[0].url, 'https://www.avito.ru/moskva/kreslo_1234567');
  assert.throws(() => normalizeFeed({ listings: [{ ...row, url: 'https://www.avito.ru.evil.test/kreslo_1234567' }] }));
  db.close();
});

test('website account stores a password hash and requires the correct password', async () => {
  const db = openStore(':memory:');
  const form = { email: 'Test@example.test', password: 'test-password-1' };
  const id = await signIn(db, form, true);
  const account = db.prepare('SELECT * FROM web_accounts WHERE id = ?').get(id);
  assert.equal(account.email, 'test@example.test');
  assert.notEqual(account.password_hash, form.password);
  assert.equal(await signIn(db, form, false), id);
  await assert.rejects(signIn(db, { ...form, password: 'wrong-password' }, false), { status: 401 });
  await assert.rejects(signIn(db, form, true), { status: 409 });
  db.close();
});

test('card checkout grants access only after a verified matching payment and closes it on a full refund', async () => {
  const db = openStore(':memory:');
  const now = 1_700_000_000;
  const config = { production: true, paymentTest: true, price: 299, webUrl: 'https://example.test', receiptVat: 1 };
  const account = { id: 42, email: 'me@example.test' };
  let payment;
  const confirmationUrl = 'https://yoomoney.ru/checkout/card';
  const call = async (path, payload, key) => {
    if (path === 'payments') {
      assert.equal(payload.payment_method_data.type, 'bank_card');
      assert.equal(payload.confirmation.return_url, 'https://example.test/web/?payment=return');
      assert.equal(payload.receipt.customer.email, account.email);
      assert.equal(key, payload.metadata.radar_order);
      payment = { id: 'payment-1', test: true, status: 'pending', paid: false, amount: payload.amount,
        metadata: payload.metadata, payment_method: { type: 'bank_card' },
        confirmation: { confirmation_url: confirmationUrl } };
    }
    if (path === 'refunds/refund-1') {
      return { id: 'refund-1', payment_id: payment.id, status: 'succeeded', amount: payment.amount };
    }
    return payment;
  };
  assert.deepEqual(await checkout(db, config, call, account, now), { checkoutUrl: confirmationUrl });
  assert.deepEqual(await checkout(db, config, call, account, now), { checkoutUrl: confirmationUrl });
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM card_orders').get().total, 1);
  const notification = { event: 'payment.succeeded', object: { id: payment.id, paid: true } };
  await handlePaymentWebhook(db, call, notification);
  assert.equal(cardAccess(db, account.id, now, true), undefined);
  payment = { ...payment, status: 'succeeded', paid: true, captured_at: new Date(now * 1000).toISOString() };
  await handlePaymentWebhook(db, () => ({ ...payment, amount: { value: '1.00', currency: 'RUB' } }), notification);
  assert.equal(cardAccess(db, account.id, now, true), undefined);
  await handlePaymentWebhook(db, call, notification);
  await handlePaymentWebhook(db, call, notification);
  assert.equal(cardAccess(db, account.id, now, true).expires_at, now + ACCESS_SECONDS);
  assert.equal(cardAccess(db, account.id, now, false), undefined);
  assert.equal(cardAccess(db, account.id, now + ACCESS_SECONDS, true), undefined);
  await handlePaymentWebhook(db, call, { event: 'refund.succeeded', object: { id: 'refund-1' } });
  assert.equal(cardAccess(db, account.id, now, true), undefined);
  db.close();
});
