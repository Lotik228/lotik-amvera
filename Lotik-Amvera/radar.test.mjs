import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { signIn } from './accounts.mjs';
import { readConfig } from './config.mjs';
import { ACCESS_SECONDS, checkout, handlePaymentWebhook, paymentState, reconcileLatestPayment } from './payments.mjs';
import { normalizeFeed, saveFeed } from './feed.mjs';
import { changeOwnerPlan, ownerOverview, ownerUser } from './owner.mjs';
import { cardAccess, openStore } from './store.mjs';
import { verifyInitData } from './telegram.mjs';

test('Telegram login requires a valid fresh signature and rejects modified identities', () => {
  const now = 1_700_000_000;
  const token = '123456:' + randomBytes(16).toString('hex');
  const user = { first_name: 'Анна', last_name: 'Петрова', username: 'anna_test', id: 42 };
  const data = new URLSearchParams({ user: JSON.stringify(user), auth_date: String(now), signature: 'test_ed25519_field' });
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', key)
    .update('auth_date=' + now + '\nsignature=' + data.get('signature') + '\nuser=' + data.get('user')).digest('hex');
  data.set('hash', hash);
  assert.deepEqual(verifyInitData(data.toString(), token, now), user);
  assert.equal(verifyInitData(data.toString(), undefined, now), null);
  assert.equal(verifyInitData(data.toString(), token + 'wrong', now), null);
  assert.equal(verifyInitData(data + '&user=%7B%7D', token, now), null);
  assert.equal(verifyInitData(data.toString(), token, now - 31), null);
  assert.equal(verifyInitData(data.toString(), token, now + 3601), null);
  data.set('user', '{"first_name":"Тест","id":15}');
  assert.equal(verifyInitData(data.toString(), token, now), null);
});

test('requires a bot token and keeps Amvera SQLite on the mounted volume', () => {
  const env = {
    AMVERA: '1', BOT_TOKEN: '123456:' + randomBytes(16).toString('hex'),
    WEBHOOK_SECRET: randomBytes(16).toString('hex'), OWNER_TELEGRAM_ID: '42',
    SUPPORT_CONTACT: '@support', PUBLIC_URL: 'https://lotik.example.test',
  };
  assert.equal(readConfig(env).dataDir, '/data');
  assert.equal(readConfig({ ...env, DATA_DIR: '/data/lotik' }).dataDir, '/data/lotik');
  assert.throws(() => readConfig({ ...env, DATA_DIR: '/data/../app/data' }), /DATA_DIR must be/);
  assert.throws(() => readConfig({ ...env, BOT_TOKEN: '' }), /BOT_TOKEN/);
  assert.throws(() => readConfig({ ...env, MODE: 'demo' }), /MODE=production/);
  assert.throws(() => readConfig({ ...env, PARSER_MODE: 'fixture' }), /Fixture mode/);
});

test('checkout is gated to local test mode even if the release environment enables it', () => {
  const env = {
    BOT_TOKEN: '123456:fixture', WEBHOOK_SECRET: 'w'.repeat(32), OWNER_TELEGRAM_ID: '42',
    SUPPORT_CONTACT: '@support', PUBLIC_URL: 'https://lotik.example.test',
    ENABLE_CARD_CHECKOUT: '1',
  };
  assert.equal(readConfig(env).cardCheckoutEnabled, false);
  assert.equal(readConfig({ ...env, YOOKASSA_TEST: '1' }).cardCheckoutEnabled, true);
  assert.equal(readConfig({ ...env, YOOKASSA_TEST: '1', LOTIK_CONTAINER: '1' }).cardCheckoutEnabled, false);
  assert.equal(readConfig({ ...env, YOOKASSA_TEST: '1', AMVERA: '1' }).cardCheckoutEnabled, false);
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
        metadata: payload.metadata,
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
  await handlePaymentWebhook(db, call, notification);
  assert.equal(cardAccess(db, account.id, now, true), undefined);
  payment.payment_method = { type: 'bank_card' };
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

test('status reconciliation checks only the current account and payment mode, including missed success and refunds', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const now = 1_700_000_000;
  const accountId = 42;
  db.prepare(`
    INSERT INTO card_orders (id, account_id, payment_id, amount_minor, created_at, attempt_json, is_test)
    VALUES ('test-order', ?, 'test-payment', 29900, ?, '{}', 1)
  `).run(accountId, now);
  const payment = {
    id: 'test-payment', test: true, status: 'succeeded', paid: true, captured_at: new Date(now * 1000).toISOString(),
    metadata: { radar_order: 'test-order' }, payment_method: { type: 'bank_card' }, amount: { value: '299.00', currency: 'RUB' },
  };
  const refund = (id, value) => ({
    id, status: 'succeeded', payment_id: payment.id, amount: { value, currency: 'RUB' },
  });
  const partial = refund('refund-a', '100.10');
  const remainder = refund('refund-b', '198.90');
  let providerPayment = { ...payment, id: 'unexpected-payment' };
  let refunds = [];
  let nextPage = [];
  let requests = 0;
  const call = async (path, payload) => {
    requests++;
    assert.equal(payload, undefined);
    if (path === 'payments/test-payment') return providerPayment;
    const url = new URL(path, 'https://provider.example.test');
    assert.equal(url.pathname, '/refunds');
    assert.equal(url.searchParams.get('payment_id'), payment.id);
    assert.equal(url.searchParams.get('status'), 'succeeded');
    if (url.searchParams.has('cursor')) {
      assert.equal(url.searchParams.get('cursor'), 'page+2');
      return { items: nextPage };
    }
    return { items: refunds, next_cursor: nextPage.length ? 'page+2' : undefined };
  };

  assert.equal(paymentState(db, accountId, now, true), 'pending');
  await reconcileLatestPayment(db, call, accountId + 1, true);
  await reconcileLatestPayment(db, call, accountId, false);
  assert.equal(requests, 0);
  await assert.rejects(reconcileLatestPayment(db, call, accountId, true), /does not match/);
  assert.equal(cardAccess(db, accountId, now, true), undefined);

  providerPayment = payment;
  await reconcileLatestPayment(db, call, accountId, true);
  assert.equal(paymentState(db, accountId, now, true), 'succeeded');
  assert.equal(cardAccess(db, accountId, now, true).expires_at, now + ACCESS_SECONDS);

  refunds = [partial, { ...remainder, payment_id: 'other-payment' }, { ...remainder, status: 'pending' }];
  await reconcileLatestPayment(db, call, accountId, true);
  assert.equal(paymentState(db, accountId, now, true), 'partially_refunded');
  assert.ok(cardAccess(db, accountId, now, true));
  nextPage = [remainder];
  await reconcileLatestPayment(db, call, accountId, true);
  assert.equal(paymentState(db, accountId, now, true), 'refunded');
  assert.equal(cardAccess(db, accountId, now, true), undefined);
  assert.equal(db.prepare('SELECT SUM(amount_minor) AS total FROM card_refunds').get().total, 29900);
});

test('status reconciliation reports cancellations and leaves orders without a payment ID for safe retry', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const now = 1_700_000_000;
  const accountId = 42;
  db.prepare(`
    INSERT INTO card_orders (id, account_id, amount_minor, created_at, attempt_json, is_test)
    VALUES ('test-order', ?, 29900, ?, '{}', 1)
  `).run(accountId, now);
  assert.equal(paymentState(db, accountId, now, true), 'not_started');
  assert.equal(paymentState(db, accountId, now + 23 * 3600, true), 'unconfirmed');
  await reconcileLatestPayment(db, () => assert.fail('No provider payment ID'), accountId, true);

  db.prepare("UPDATE card_orders SET payment_id = 'test-payment'").run();
  await reconcileLatestPayment(db, async path => {
    assert.equal(path, 'payments/test-payment');
    return {
      id: 'test-payment', test: true, status: 'canceled', metadata: { radar_order: 'test-order' },
      amount: { value: '299.00', currency: 'RUB' },
    };
  }, accountId, true);
  assert.equal(paymentState(db, accountId, now, true), 'canceled');
  assert.equal(cardAccess(db, accountId, now, true), undefined);
});

test('owner overview separates web access, real revenue and Telegram plan counts', t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const now = 1_700_000_000;
  db.exec(`
    INSERT INTO users (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C');
    INSERT INTO watch_plans VALUES (2, 'medium'), (3, 'fast'), (4, 'fast');
    INSERT INTO web_accounts (id, email, password_hash) VALUES
      (1, 'one@example.test', 'hash'), (2, 'two@example.test', 'hash'), (3, 'three@example.test', 'hash'),
      (4, 'four@example.test', 'hash'), (5, 'five@example.test', 'hash');
  `);
  const insert = db.prepare(`
    INSERT INTO card_orders (id, account_id, amount_minor, created_at, attempt_json, status, expires_at, is_test)
    VALUES (?, ?, 29900, ?, '{}', ?, ?, ?)
  `);
  insert.run('partial', 1, now - 5, 'succeeded', now + 100, 0);
  insert.run('second-active', 1, now - 4, 'succeeded', now + 100, 0);
  insert.run('refunded', 2, now - 3, 'succeeded', now + 100, 0);
  insert.run('test', 3, now - 2, 'succeeded', now + 100, 1);
  insert.run('expired', 4, now - 1, 'succeeded', now, 0);
  insert.run('pending', 5, now, 'pending', null, 0);
  db.exec("INSERT INTO card_refunds VALUES ('one', 'partial', 10010), ('two', 'refunded', 29900)");
  const overview = ownerOverview(db, now);
  assert.equal(overview.netRub, 796.90);
  assert.equal(overview.accounts, 5);
  assert.equal(overview.activeWebAccounts, 1);
  assert.deepEqual(overview.telegramPlans.map(plan => plan.total), [1, 1, 1]);
  assert.deepEqual(overview.orders.map(order => order.accountId), [5, 4, 3, 2, 1, 1]);
  assert.equal(overview.orders[2].isTest, true);
  assert.equal(overview.orders[3].refundedMinor, 29900);
  assert.equal(overview.orders[5].refundedMinor, 10010);
});

test('owner can find a Telegram user and change their plan with an atomic, idempotent audit', t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const now = 1_700_000_000;
  db.exec(`
    INSERT INTO users (id, name, username) VALUES (42, 'Owner', 'owner'), (60, 'Client', 'Client'), (61, 'Other', 'other');
    INSERT INTO watch_plans VALUES (60, 'fast');
    INSERT INTO saved_searches (id, query, city, max_price) VALUES (1, 'a', '', 0), (2, 'b', '', 0);
    INSERT INTO saved_search_users (search_id, user_id, new_enabled, drop_enabled, due_at)
    VALUES (1, 60, 1, 0, 0), (2, 60, 0, 1, 0), (1, 61, 1, 0, 0), (2, 62, 0, 1, 0);
  `);
  assert.equal(ownerUser(db, '@CLIENT').user.plan, 'fast');
  assert.equal(ownerUser(db, '62').user.savedSearches, 1);
  assert.throws(() => ownerUser(db, 'https://example.test'), { status: 400 });
  assert.throws(() => ownerUser(db, '999'), { status: 404 });
  assert.throws(() => changeOwnerPlan(db, 42, { userId: 60, plan: 'invalid', expectedPlan: 'fast' }, now), { status: 400 });
  const input = { userId: 60, plan: 'basic', expectedPlan: 'fast' };
  const { user } = changeOwnerPlan(db, 42, input, now);
  assert.equal(user.plan, 'basic');
  assert.equal(user.savedSearches, 2);
  assert.equal(user.enabledSearches, 1);
  assert.equal(ownerUser(db, '61').user.enabledSearches, 1);
  changeOwnerPlan(db, 42, input, now + 1);
  assert.throws(() => changeOwnerPlan(db, 42, { ...input, plan: 'medium' }, now + 1), { status: 409 });
  assert.deepEqual(ownerOverview(db, now).planChanges.map(change => [
    change.actorId, change.userId, change.changedAt, change.pausedSearches,
  ]), [[42, 60, now, 1]]);
});
