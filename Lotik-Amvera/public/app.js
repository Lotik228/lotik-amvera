const tg = window.Telegram?.WebApp;
const web = document.body.classList.contains('web');
const initData = tg?.initData || '';
tg?.ready();
tg?.expand();

const $ = id => document.getElementById(id);
const state = { profile: null, page: null, feedPage: 0, savedPage: 0, watchPage: 1, requests: {} };
const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });
const shortTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const categories = { 'Электроника': '▣', 'Спорт': '↗', 'Для дома': '◇' };

function avitoSearchLink() {
  const cities = state.profile?.searchCities ?? {};
  const selected = $('city').value;
  const location = Object.hasOwn(cities, selected) ? selected :
    Object.keys(cities).find(slug => cities[slug] === selected) ?? 'all';
  const url = new URL('/' + location, 'https://www.avito.ru');
  const query = $('query').value.trim();
  if (query) url.searchParams.set('q', query);
  $('search-on-avito').href = url.href;
  return url.href;
}

function openAvitoSearch(url) {
  if (initData && tg.openLink) tg.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function setupSearch() {
  const mode = state.profile.searchMode;
  const external = mode === 'external';
  const direct = $('search-on-avito');
  $('search-submit').hidden = external;
  $('category').hidden = mode !== 'snapshot';
  $('max').hidden = external;
  $('sort').hidden = external;
  $('results-heading').hidden = external;
  direct.className = external ? 'primary' : 'secondary';
  direct.textContent = external ? 'Искать на Авито ↗' : 'Открыть поиск на Авито ↗';
  if (mode !== 'snapshot') {
    const city = $('city');
    const current = city.value;
    const choices = state.profile.searchCities ?? {};
    city.replaceChildren(...Object.entries(choices).map(([slug, name]) => new Option(name, slug)));
    if (Object.hasOwn(choices, current)) city.value = current;
  }
  avitoSearchLink();
}

async function api(path, method = 'GET', data) {
  const response = await fetch((web ? '/web/api/' : '/api/') + path, {
    method,
    headers: {
      ...(!web && { 'X-Telegram-Init-Data': initData }),
      ...(data && { 'Content-Type': 'application/json' }),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!web && response.status === 401) {
    state.profile = null;
    state.page = null;
    state.requests = {};
    for (const view of document.querySelectorAll('.view')) view.hidden = true;
    $('nav').hidden = true;
    $('avatar').hidden = true;
    notice(result.error);
  }
  if (!response.ok) throw new Error(result.error);
  return result;
}

function notice(text) {
  $('notice').textContent = text || '';
  $('notice').hidden = !text;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function watchMessage(text, error = false) {
  const message = $('watch-status');
  message.textContent = text || '';
  message.hidden = !text;
  message.classList.toggle('error', error);
}

function updateWatchCountdowns() {
  const now = Math.floor(Date.now() / 1000) + (state.watchClockOffset ?? 0);
  for (const node of document.querySelectorAll('[data-watch-due]')) {
    const remaining = Math.max(0, Number(node.dataset.watchDue) - now);
    if (!remaining) {
      node.textContent = 'Проверяем объявление…';
      continue;
    }
    const minutes = Math.floor(remaining / 60);
    const label = (minutes ? minutes + ' мин ' : '') + remaining % 60 + ' сек';
    node.textContent = (node.dataset.checked === 'true' ? 'Следующая проверка через ' : 'Первая проверка через ') + label;
  }
}

async function loadWatches() {
  const request = Symbol();
  const page = state.watchPage;
  state.requests.watches = request;
  const { now, ...data } = await api('watches?page=' + page);
  if (state.requests.watches !== request) return;
  state.watchClockOffset = now - Math.floor(Date.now() / 1000);
  const snapshot = JSON.stringify([page, data]);
  if (state.watchSnapshot === snapshot) {
    updateWatchCountdowns();
    return;
  }
  state.watchSnapshot = snapshot;
  $('watch-plan-label').textContent = data.plan.name + ' · проверка через каждые ' + data.plan.label;
  $('watch-summary').textContent = data.enabled ? '' : 'Проверка отдельных объявлений недоступна без источника.';
  const cards = data.rows.map(row => {
    const card = element('article', 'card watch-row');
    const info = element('div', '');
    const title = element('a', 'ad-title', (row.title || 'Объявление № ' + row.id) + ' ↗');
    title.href = row.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    if (tg?.initData && tg.openLink) title.addEventListener('click', event => {
      event.preventDefault();
      tg.openLink(row.url);
    });
    info.append(title, element('p', 'helper', data.enabled ? row.status : 'Автоматические проверки не выполняются.'));
    const timer = element('p', 'helper');
    if (data.enabled) {
      timer.dataset.watchDue = row.dueAt;
      timer.dataset.checked = Boolean(row.checkedAt);
    }
    const remove = element('button', 'secondary', 'Остановить');
    remove.type = 'button';
    remove.addEventListener('click', () => run(async () => {
      await api('watches', 'DELETE', { id: row.id });
      if (data.rows.length === 1 && state.watchPage > 1) state.watchPage--;
      await loadWatches();
      watchMessage('Отслеживание остановлено.');
    }));
    card.append(info, timer, remove);
    return card;
  });
  $('watch-list').replaceChildren(...(cards.length ? cards : [element('p', 'empty', 'Здесь появятся объявления, за которыми вы следите.')]));
  $('watch-prev').hidden = page <= 1;
  $('watch-next').hidden = !data.hasNext;
  updateWatchCountdowns();
}

async function trackLink() {
  if (state.addingWatch) return;
  const field = $('watch-url');
  const url = field.value.trim();
  if (!url) return;
  state.addingWatch = true;
  $('watch-submit').disabled = true;
  watchMessage('Добавляем ссылку…');
  try {
    const result = await api('watches', 'POST', { url });
    if (field.value.trim() === url) field.value = '';
    if (result.kind === 'search') {
      await loadSavedSearches();
      watchMessage(searchSavedText(result));
      return;
    }
    state.watchPage = 1;
    await loadWatches();
    watchMessage(result.added ? 'Отслеживание включено.' : 'Это объявление уже отслеживается.');
  } catch (error) {
    watchMessage(error.message, true);
  } finally {
    state.addingWatch = false;
    $('watch-submit').disabled = false;
  }
}

function savedSearchMessage(text, error = false) {
  const node = $('saved-search-message');
  node.textContent = text || '';
  node.hidden = !text;
  node.classList.toggle('error', error);
}

function savedSearchSettings(container) {
  return {
    newEnabled: container.querySelector('[name="newEnabled"]').checked,
    dropEnabled: container.querySelector('[name="dropEnabled"]').checked,
  };
}

function sourceNotice(sourceState) {
  if (sourceState === 'off') return 'Источник не подключён. Проверки и уведомления не работают.';
  if (sourceState === 'paused') return 'Источник приостановлен. Проверки и уведомления временно недоступны.';
  return '';
}

function searchSavedText(result) {
  const parts = [result.alreadySaved ? 'Поиск уже сохранён.' : 'Поиск сохранён.'];
  if (result.limitReached) parts.push('Лимит тарифа достигнут. Для этого поиска уведомления выключены.');
  else if (!result.notificationsEnabled) parts.push('Уведомления выключены.');
  parts.push(sourceNotice(result.sourceState));
  return parts.filter(Boolean).join(' ');
}

async function loadSavedSearches() {
  const request = Symbol();
  state.requests.savedSearches = request;
  const data = await api('search-watches');
  if (state.requests.savedSearches !== request) return;
  const snapshot = JSON.stringify(data);
  if (snapshot === state.savedSearchSnapshot) return;
  state.savedSearchSnapshot = snapshot;
  const city = $('saved-search-city');
  const current = city.value;
  city.replaceChildren(...Object.entries(data.cities).map(([key, label]) => new Option(label, key)));
  if (Object.hasOwn(data.cities, current)) city.value = current;
  const configuredCount = data.rows.filter(row => row.new_enabled || row.drop_enabled).length;
  const limit = 'Поисков с включёнными уведомлениями: ' + configuredCount + ' из ' + data.plan.searchLimit + '.';
  $('saved-search-summary').textContent = !data.enabled && !data.linkEnabled
    ? 'Можно сохранять поиски и выбирать уведомления. Без источника проверки не выполняются. ' + limit
    : limit;
  const list = $('saved-search-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.activity));
  list.replaceChildren(...data.rows.map(row => {
    const card = element('article', 'card saved-search-card');
    const remove = element('button', 'secondary', 'Удалить поиск');
    remove.type = 'button';
    remove.addEventListener('click', () => run(async () => {
      await api('search-watches', 'DELETE', { id: row.id });
      await loadSavedSearches();
      savedSearchMessage('Поиск удалён.');
    }));
    if (row.source_url) {
      const url = new URL(row.source_url);
      card.append(element('h3', '', url.searchParams.get('q')?.trim().slice(0, 100) || 'Поиск по ссылке Авито'));
      const link = element('a', 'ad-title', 'Открыть поиск на Авито ↗');
      link.href = row.source_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (tg?.initData && tg.openLink) link.addEventListener('click', event => {
        event.preventDefault();
        tg.openLink(row.source_url);
      });
      card.append(link);
    } else {
      card.append(element('h3', '', row.query));
    }
    const location = row.source_url ? '' : data.cities[row.city];
    const sourceEnabled = row.source_url ? data.linkEnabled : data.enabled;
    const price = row.max_price ? ' · до ' + money.format(row.max_price) + ' ₽' : '';
    const sourceState = !sourceEnabled ? 'off' : row.source_url && data.parserPaused ? 'paused' : 'ready';
    const configured = Boolean(row.new_enabled || row.drop_enabled);
    const status = [
      sourceState === 'off' ? 'Сохранён. Источник не подключён, проверки не выполняются.' : sourceNotice(sourceState),
      !configured ? 'Уведомления выключены.' : sourceState !== 'ready' ? 'Настройки уведомлений сохранены.' : '',
      row.checked_at ? 'Последняя успешная проверка: ' + shortTime.format(row.checked_at * 1000)
        : configured && sourceState === 'ready' ? 'Ожидает первой проверки.' : '',
    ].filter(Boolean).join(' ');
    card.append(element('p', 'helper', [location + price, status].filter(Boolean).join(' · ')));
    const switches = element('div', 'watch-switches');
    const inputs = [['newEnabled', 'Новые объявления', row.new_enabled], ['dropEnabled', 'Снижение цены', row.drop_enabled]]
      .map(([name, label, value]) => {
        const wrap = element('label', '');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = name;
        checkbox.checked = Boolean(value);
        checkbox.setAttribute('role', 'switch');
        wrap.append(checkbox, label);
        switches.append(wrap);
        return checkbox;
      });
    for (const checkbox of inputs) checkbox.addEventListener('change', () => run(async () => {
      for (const control of inputs) control.disabled = true;
      try {
        const result = await api('search-watches', 'PUT', { id: row.id, ...savedSearchSettings(switches) });
        await loadSavedSearches();
        savedSearchMessage([result.notificationsEnabled ? 'Настройки уведомлений сохранены.' : 'Уведомления выключены.',
          sourceNotice(result.sourceState)].filter(Boolean).join(' '));
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        savedSearchMessage(error.message, true);
      } finally {
        for (const control of inputs) control.disabled = false;
      }
    }));
    card.append(switches);
    if (row.latest_new || row.latest_drop) {
      const activity = element('details', '');
      activity.dataset.activity = row.id;
      activity.open = open.has(String(row.id));
      activity.append(element('summary', '', 'Последние события'));
      for (const text of [row.latest_new, row.latest_drop].filter(Boolean)) {
        activity.append(element('p', 'saved-search-activity', text));
      }
      card.append(activity);
    }
    card.append(remove);
    return card;
  }));
}

function setOptions(select, values, title) {
  const current = select.value;
  select.replaceChildren(new Option(title, ''), ...values.map(value => new Option(value, value)));
  if (values.includes(current)) select.value = current;
}

function adCard(ad) {
  const row = element('article', 'ad');
  const icon = element('span', 'ad-icon', categories[ad.category] || '◇');
  icon.setAttribute('aria-hidden', 'true');
  const info = element('div', 'ad-info');
  const title = element('a', 'ad-title', ad.title + ' ↗');
  title.href = ad.url;
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  if (tg?.initData && tg.openLink) title.addEventListener('click', event => {
    event.preventDefault();
    tg.openLink(ad.url);
  });
  const meta = [ad.city, ad.category, ad.posted_at == null ? '' : shortTime.format(ad.posted_at)].filter(Boolean);
  info.append(title, element('p', 'ad-meta', meta.join(' · ')));
  const price = element('span', 'ad-price', ad.price == null ? 'Цена не указана' : money.format(ad.price) + ' ₽');
  const save = element('button', 'heart', ad.saved ? '♥' : '♡');
  save.type = 'button';
  save.setAttribute('aria-label', 'Избранное: ' + ad.title);
  save.setAttribute('aria-pressed', Boolean(ad.saved));
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const result = await api('favorite', 'PUT', { id: ad.id, saved: !ad.saved });
      ad.saved = result.saved;
      save.textContent = ad.saved ? '♥' : '♡';
      save.setAttribute('aria-pressed', ad.saved);
      if (state.page === 'saved') await loadAds(true);
    } catch (error) { notice(error.message); }
    finally { save.disabled = false; }
  });
  row.append(icon, info, price, save);
  return row;
}

async function loadAds(saved = false, append = false) {
  const key = saved ? 'savedPage' : 'feedPage';
  const target = $(saved ? 'saved-ads' : 'ads');
  const next = $(saved ? 'next-saved' : 'next-feed');
  const mode = state.profile.searchMode;
  const market = !saved && mode === 'market';
  const page = market ? (append ? state.marketNext : 1) : append ? state[key] + 1 : 0;
  const query = saved ? new URLSearchParams({ saved: '1' })
    : market && append ? new URLSearchParams(state.marketQuery)
      : new URLSearchParams(new FormData($('filters')));
  if (!saved) {
    avitoSearchLink();
    if (mode === 'external' || (market && !query.get('q')?.trim())) {
      state.requests[key] = Symbol();
      $('results').textContent = mode === 'external' ? 'Актуальные результаты откроются на Авито.'
        : 'Введите товар, чтобы загрузить выдачу Авито.';
      $('locked').hidden = true;
      next.hidden = true;
      target.replaceChildren();
      return;
    }
    if (!append) {
      $('results').textContent = 'Ищем объявления…';
      $('locked').hidden = true;
      next.hidden = true;
      target.replaceChildren();
    }
  }
  query.set('page', page);
  if (!saved && !(market && append)) query.set('sort', $('sort').value);
  if (market && !append) state.marketQuery = query.toString();
  const request = Symbol();
  state.requests[key] = request;
  next.disabled = true;
  try {
    const data = await api('feed?' + query);
    if (state.requests[key] !== request) return;
    state[key] = page;
    if (!saved) {
      const count = 'Найдено ' + money.format(data.total);
      $('results').textContent = market ? count + ' в выдаче Авито' : !data.lastSync ? 'Источник объявлений пока недоступен'
        : count + ' в загруженной ленте';
      $('locked').hidden = !web || !data.limited;
      if (market) state.marketNext = data.nextPage;
      else {
        setOptions($('city'), data.cities, 'Все города');
        setOptions($('category'), data.categories, 'Все категории');
      }
    }
    if (!append) target.replaceChildren();
    if (data.rows.length) target.append(...data.rows.map(adCard));
    else if (!append) target.append(element('p', 'empty', saved ? 'Здесь появятся сохранённые объявления.' : 'Объявлений по этому запросу пока нет.'));
    next.hidden = !(market ? data.nextPage : data.hasNext);
  } catch (error) {
    if (!saved && state.requests[key] === request) $('results').textContent = error.message;
    else if (saved) throw error;
  } finally {
    if (state.requests[key] === request) next.disabled = false;
  }
}

function paymentStatusText(profile) {
  switch (profile.paymentState) {
    case 'not_started': return 'Есть незавершённая попытка. Продолжите оплату на странице веб-доступа.';
    case 'unconfirmed': return 'Статус предыдущей оплаты требует проверки. Свяжитесь с поддержкой.';
    case 'pending': return 'Ожидаем подтверждение оплаты от ЮKassa.';
    case 'canceled': return 'Платёж отменён. Оплату можно начать заново.';
    case 'refunded': return 'Полный возврат подтверждён.';
    case 'partially_refunded': return 'Частичный возврат подтверждён.';
    case 'succeeded': return profile.expiresAt ? 'Оплата подтверждена.' : 'Оплата подтверждена. Срок веб-доступа истёк.';
    default: return '';
  }
}

async function refreshProfile() {
  renderProfile(await api('me'));
}

function renderProfile(profile) {
  state.profile = profile;
  const signedOut = web && !profile.signedIn;
  $('nav').hidden = signedOut;
  $('avatar').hidden = signedOut;
  if (signedOut) {
    $('avatar').textContent = '→';
    return;
  }
  $('avatar').textContent = [...profile.name][0]?.toLocaleUpperCase('ru') || '●';
  if (web) $('price').textContent = money.format(profile.price);
  $('profile-name').textContent = profile.name;
  $('username').textContent = profile.username ? '@' + profile.username : '';
  $('membership').textContent = web
    ? (profile.expiresAt ? 'Лотик Pro на сайте до ' + dateFormat.format(profile.expiresAt * 1000) : 'Бесплатный веб-доступ')
    : (profile.monitoringPlan ? 'Тариф мониторинга «' + profile.monitoringPlan.name + '»' : '');
  $('support').hidden = !profile.support;
  $('support').textContent = profile.support ? 'Поддержка по оплате: ' + profile.support : '';
  $('owner').hidden = !profile.isOwner;
  if (!web) return;
  const orderStatus = paymentStatusText(profile);
  $('order-status').textContent = orderStatus;
  $('order-status').hidden = !orderStatus;
  $('check-payment').hidden = !profile.canCheckPayment || !['pending', 'succeeded', 'partially_refunded'].includes(profile.paymentState);
  $('subscribe').disabled = Boolean(profile.expiresAt) || !profile.canSubscribe;
  $('subscribe').textContent = profile.expiresAt ? 'Лотик Pro активен'
    : ['pending', 'not_started'].includes(profile.paymentState) ? 'Продолжить оплату' : 'Оплатить картой';
  $('payment-status').textContent = !profile.canSubscribe ? 'Оплата пока недоступна.'
    : profile.testPayments ? 'Тестовый магазин ЮKassa.' : 'Защищённая платёжная страница ЮKassa. Продление вручную.';
}

async function openPage(page) {
  if (!state.profile || page === 'account' || page === 'plans') await refreshProfile();
  if (web && !state.profile.signedIn) page = 'login-view';
  state.page = page;
  notice('');
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== page;
  for (const button of document.querySelectorAll('.nav [data-page]')) {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (page === 'watch-view') await loadWatches();
  if (page === 'watch-view') await loadSavedSearches();
  if (page === 'feed') {
    setupSearch();
    await loadAds();
  }
  if (page === 'saved') await loadAds(true);
  if (page === 'account' && state.profile.isOwner) {
    const owner = await api('owner');
    $('balance').textContent = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(owner.netRub);
    $('accounts').textContent = money.format(owner.accounts);
    $('api-daily').textContent = money.format(owner.budget.today) + ' / ' + money.format(owner.budget.daily);
    $('api-monthly').textContent = money.format(owner.budget.month) + ' / ' + money.format(owner.budget.monthly);
    $('source').textContent = owner.liveFeed && owner.lastSync ? shortTime.format(owner.lastSync)
      : owner.liveFeed ? 'Ожидает загрузки' : 'Не подключён';
  }
}

function run(callback) {
  void callback().catch(error => notice(error.message));
}

for (const button of document.querySelectorAll('[data-page]')) {
  button.addEventListener('click', () => run(() => openPage(button.dataset.page)));
}
$('avatar').addEventListener('click', () => run(() => openPage('account')));
$('watch-form').addEventListener('submit', event => {
  event.preventDefault();
  run(trackLink);
});
$('saved-search-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  run(async () => {
    const button = $('save-search');
    button.disabled = true;
    try {
      const result = await api('search-watches', 'POST', {
        query: fields.get('query'), city: fields.get('city'), maxPrice: Number(fields.get('maxPrice')), ...savedSearchSettings(form),
      });
      form.elements.query.value = '';
      await loadSavedSearches();
      savedSearchMessage(searchSavedText(result));
    } catch (error) {
      savedSearchMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
});
$('saved-search-link-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.sourceUrl;
  const button = form.querySelector('button');
  run(async () => {
    button.disabled = true;
    try {
      const result = await api('search-watches', 'POST', { sourceUrl: input.value.trim(), newEnabled: true, dropEnabled: false });
      input.value = '';
      await loadSavedSearches();
      savedSearchMessage(searchSavedText(result));
    } catch (error) {
      savedSearchMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
});
$('watch-url').addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text/plain').trim();
  if (!text) return;
  event.preventDefault();
  $('watch-url').value = text;
  run(trackLink);
});
$('watch-prev').addEventListener('click', () => run(async () => {
  state.watchPage--;
  await loadWatches();
}));
$('watch-next').addEventListener('click', () => run(async () => {
  state.watchPage++;
  await loadWatches();
}));
setInterval(() => {
  if (state.page === 'watch-view') updateWatchCountdowns();
}, 1000);
setInterval(() => {
  if (state.page === 'watch-view' && !state.addingWatch) {
    void loadWatches().catch(() => { $('watch-summary').textContent = 'Обновляем состояние отслеживания…'; });
  }
  if (state.page === 'watch-view') void loadSavedSearches().catch(() => {});
}, 3000);
$('filters').addEventListener('submit', event => {
  event.preventDefault();
  if (state.profile.searchMode === 'external') {
    openAvitoSearch(avitoSearchLink());
    return;
  }
  run(() => loadAds());
});
$('search-on-avito').addEventListener('click', event => {
  if (tg?.initData && tg.openLink) {
    event.preventDefault();
    openAvitoSearch(avitoSearchLink());
  }
});
$('query').addEventListener('input', avitoSearchLink);
for (const id of ['city', 'category', 'sort']) $(id).addEventListener('change', () => {
  avitoSearchLink();
  if (state.profile.searchMode === 'snapshot') run(() => loadAds());
});
$('next-feed').addEventListener('click', () => run(() => loadAds(false, true)));
$('next-saved').addEventListener('click', () => run(() => loadAds(true, true)));

$('subscribe').addEventListener('click', () => run(async () => {
  $('subscribe').disabled = true;
  try {
    const result = await api('subscribe', 'POST');
    if (result.checkoutUrl) return window.location.assign(result.checkoutUrl);
    if (result.paid || result.canceled) await refreshProfile();
    if (result.canceled) notice('Платёж отменён. Вы можете попробовать ещё раз.');
  } finally {
    $('subscribe').disabled = Boolean(state.profile.expiresAt) || !state.profile.canSubscribe;
  }
}));

$('logout').addEventListener('click', () => run(async () => {
  await api('logout', 'POST');
  await refreshProfile();
  await openPage('login-view');
}));

async function checkPayment() {
  const button = $('check-payment');
  button.disabled = true;
  try {
    const status = await api('payment-status', 'POST');
    renderProfile(status);
    notice(paymentStatusText(status) || 'В этом аккаунте пока нет платежей.');
  } finally {
    button.disabled = false;
  }
}
$('check-payment').addEventListener('click', () => run(checkPayment));
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const form = event.currentTarget ?? $('login-form');
    const submit = event.submitter;
    const kind = submit?.value === 'register' ? 'register' : 'login';
    const fields = Object.fromEntries(new FormData(form));
    const buttons = [...form.querySelectorAll('button')];
    for (const button of buttons) button.disabled = true;
    try {
      await api(kind, 'POST', fields);
      form.reset();
      await refreshProfile();
      await openPage('watch-view');
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  });
});

run(async () => {
  if (!web && !initData) {
    notice('Откройте Лотик из меню бота в Telegram.');
    return;
  }
  await refreshProfile();
  if (web && state.profile.signedIn && new URLSearchParams(window.location.search).get('payment') === 'return') {
    await openPage('account');
    history.replaceState(null, '', '/web/');
    await checkPayment();
    return;
  }
  await openPage('watch-view');
});
