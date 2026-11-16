import { plans, setPlan } from './watches.mjs';

const planOptions = Object.entries(plans).map(([key, { name, searchLimit }]) => ({ key, name, searchLimit }));

function ownerError(message, status) {
  return Object.assign(new Error(message), { status });
}

export function ownerUser(db, query) {
  const value = typeof query === 'string' ? query.trim() : '';
  let id = Number(value);
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(id) || id <= 0) {
    if (!/^@?[a-z][a-z0-9_]{0,31}$/i.test(value)) {
      throw ownerError('Укажите Telegram ID или @username.', 400);
    }
    const matches = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 2')
      .all(value.replace(/^@/, ''));
    if (matches.length > 1) throw ownerError('Найдено несколько профилей. Укажите Telegram ID.', 409);
    id = matches[0]?.id;
  }
  if (!id) throw ownerError('Пользователь не найден.', 404);

  const user = db.prepare(`
    SELECT ? AS id, name, username,
      COALESCE((SELECT plan FROM watch_plans WHERE user_id = ?), 'basic') AS plan,
      (SELECT COUNT(*) FROM saved_search_users WHERE user_id = ?) AS savedSearches,
      (SELECT COUNT(*) FROM saved_search_users WHERE user_id = ? AND (new_enabled OR drop_enabled)) AS enabledSearches,
      (SELECT COUNT(*) FROM watches WHERE user_id = ?) AS savedListings
    FROM (SELECT 1) LEFT JOIN users ON users.id = ?
  `).get(id, id, id, id, id, id);
  if (user.name === null && !user.savedSearches && !user.savedListings) {
    throw ownerError('Пользователь не найден.', 404);
  }
  return { user, plans: planOptions };
}

export function changeOwnerPlan(db, actorId, input, now) {
  const { userId, plan, expectedPlan } = input ?? {};
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof plan !== 'string' || !Object.hasOwn(plans, plan)
    || typeof expectedPlan !== 'string' || !Object.hasOwn(plans, expectedPlan)) {
    throw ownerError('Укажите пользователя и тариф.', 400);
  }
  ownerUser(db, String(userId));
  setPlan(db, userId, plan, now, { actorId, expectedPlan });
  return ownerUser(db, String(userId));
}

export function ownerOverview(db, now) {
  const { netMinor, activeWebAccounts } = db.prepare(`
    WITH paid_orders AS (
      SELECT account_id, expires_at, amount_minor - COALESCE((
        SELECT SUM(amount_minor) FROM card_refunds WHERE order_id = card_orders.id
      ), 0) AS net
      FROM card_orders WHERE status = 'succeeded' AND is_test = 0
    )
    SELECT COALESCE(SUM(net), 0) AS netMinor,
      COUNT(DISTINCT CASE WHEN net > 0 AND expires_at > ? THEN account_id END) AS activeWebAccounts
    FROM paid_orders
  `).get(now);
  const planCounts = db.prepare(`
    SELECT COALESCE(watch_plans.plan, 'basic') AS plan, COUNT(*) AS total
    FROM users LEFT JOIN watch_plans ON watch_plans.user_id = users.id
    GROUP BY COALESCE(watch_plans.plan, 'basic')
  `).all();
  const counts = new Map(planCounts.map(row => [row.plan, row.total]));
  const orders = db.prepare(`
    SELECT account_id AS accountId, created_at AS createdAt, amount_minor AS amountMinor,
      status, is_test AS isTest, COALESCE((
        SELECT SUM(amount_minor) FROM card_refunds WHERE order_id = card_orders.id
      ), 0) AS refundedMinor
    FROM card_orders ORDER BY created_at DESC, rowid DESC LIMIT 10
  `).all();
  const planChanges = db.prepare(`
    SELECT actor_id AS actorId, user_id AS userId, previous_plan AS previousPlan,
      new_plan AS newPlan, changed_at AS changedAt, paused_searches AS pausedSearches
    FROM owner_plan_changes ORDER BY id DESC LIMIT 10
  `).all();
  return {
    netRub: netMinor / 100,
    accounts: db.prepare('SELECT COUNT(*) AS count FROM web_accounts').get().count,
    activeWebAccounts,
    telegramPlans: Object.entries(plans).map(([key, plan]) => ({ name: plan.name, total: counts.get(key) ?? 0 })),
    orders: orders.map(order => ({ ...order, isTest: Boolean(order.isTest) })),
    planChanges: planChanges.map(change => ({
      ...change, previousPlan: plans[change.previousPlan].name, newPlan: plans[change.newPlan].name,
    })),
  };
}
