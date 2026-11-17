const tg = window.Telegram?.WebApp;
const web = document.body.classList.contains('web');
const initData = tg?.initData || '';
tg?.ready();
tg?.expand();

const $ = id => document.getElementById(id);
const state = { profile: null, page: null, feedPage: 0, savedPage: 0, watchPage: 1, requests: {} };
let ownerCustomer;
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

function setActionBusy(button, busy) {
  button.disabled = busy;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

async function loadList(path, target, key, request) {
  target.setAttribute('aria-busy', 'true');
  try {
    return await api(path);
  } finally {
    if (state.requests[key] === request) target.removeAttribute('aria-busy');
  }
}

function trackingMessage(id, text, error = false) {
  const message = $(id);
  message.textContent = text || '';
  message.hidden = !text;
  message.classList.toggle('error', error);
}

function updateWatchCountdowns() {
  const now = Math.floor(Date.now() / 1000) + (state.watchClockOffset ?? 0);
  for (const node of document.querySelectorAll('[data-watch-due]')) {
    const remaining = Math.max(0, Number(node.dataset.watchDue) - now);
    if (!remaining) {
      node.textContent = 'Ожидает проверки.';
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
  const path = 'watches?page=' + page;
  const { now, ...data } = await (state.watchSnapshot ? api(path) : loadList(path, $('watch-list'), 'watches', request));
  if (state.requests.watches !== request) return;
  state.watchClockOffset = now - Math.floor(Date.now() / 1000);
  const snapshot = JSON.stringify([page, data]);
  if (state.watchSnapshot === snapshot) {
    updateWatchCountdowns();
    return;
  }
  state.watchSnapshot = snapshot;
  state.watchData = data;
  renderTrackingOverview();
  $('watch-summary').textContent = data.enabled ? '' : 'Проверка отдельных объявлений недоступна без источника.';
  const cards = data.rows.map(row => {
    const card = element('article', 'card watch-row');
    const info = element('div', '');
    const title = element('a', 'ad-title', listingTrackingName(row) + ' ↗');
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
      setActionBusy(remove, true);
      try {
        await api('watches', 'DELETE', { id: row.id });
        if (data.rows.length === 1 && state.watchPage > 1) state.watchPage--;
        await loadWatches();
        trackingMessage('watch-status', 'Отслеживание остановлено.');
      } finally {
        setActionBusy(remove, false);
      }
    }));
    card.append(info, timer, remove);
    return card;
  });
  $('watch-list').replaceChildren(...(cards.length ? cards : [element('p', 'empty', 'Здесь появятся объявления, за которыми вы следите.')]));
  $('watch-prev').hidden = page <= 1;
  $('watch-next').hidden = !data.hasNext;
  updateWatchCountdowns();
}

function listingTrackingName(row) {
  return row.name || row.title || 'Объявление № ' + row.id;
}

function searchTrackingName(row) {
  return row.tracking_name || (row.source_url ? new URL(row.source_url).searchParams.get('q')?.trim().slice(0, 100)
    || 'Поиск по ссылке Авито' : row.query);
}

function renderTrackingOverview() {
  const watches = state.watchData;
  const searches = state.searchData;
  if (!watches || !searches) return;
  const active = searches.rows.filter(row => row.new_enabled || row.drop_enabled).length;
  $('watch-plan-label').textContent = searches.plan.name + ' · поиски с уведомлениями: ' + active + ' из ' + searches.plan.searchLimit;
  const total = watches.total + searches.rows.length;
  $('watch-count').textContent = 'Сохранено: ' + total;
  $('watch-empty').hidden = total > 0;
  const preview = $('watch-preview');
  const items = [...searches.rows.slice(0, 2).map(row => ['Поиск', searchTrackingName(row)]),
    ...watches.rows.slice(0, 2).map(row => ['Объявление', listingTrackingName(row)])];
  preview.hidden = !items.length;
  preview.replaceChildren(...items.slice(0, 3).map(([kind, title]) => {
    const item = element('li', '');
    item.append(element('span', '', title), element('small', '', kind));
    return item;
  }));
}

async function setupTrackingLink() {
  const field = $('watch-url');
  const url = field.value.trim();
  const button = $('watch-submit');
  if (!url || button.disabled) return;
  setActionBusy(button, true);
  trackingMessage('watch-entry-message', '');
  try {
    const link = await api('watches/resolve', 'POST', { url });
    if (state.page !== 'watch-view' || field.value.trim() !== url) return;
    state.trackingDraft = link;
    const search = link.kind === 'search';
    const form = $('watch-setup-form');
    form.reset();
    $('watch-setup-link').href = link.url;
    $('watch-setup-kind').textContent = search ? 'Поиск по ссылке Авито' : 'Отдельное объявление Авито';
    $('watch-setup-search').hidden = !search;
    if (search) {
      const avitoUrl = new URL(link.url);
      form.elements.name.value = avitoUrl.searchParams.get('q')?.trim().slice(0, 100) || '';
      const city = state.profile.searchCities?.[avitoUrl.pathname.split('/')[1]];
      const max = avitoUrl.searchParams.get('pmax') ?? avitoUrl.searchParams.get('priceMax') ?? avitoUrl.searchParams.get('price_max');
      $('watch-setup-filters').textContent = [
        city && 'Регион · ' + city,
        /^\d{1,11}$/.test(max ?? '') && Number(max) > 0 && 'Цена до ' + money.format(Number(max)) + ' ₽',
        'Фильтры берутся из ссылки. Измените их на Авито и вставьте обновлённую ссылку.',
      ].filter(Boolean).join(' · ');
    }
    $('watch-setup-save').disabled = !search && !link.listingEnabled;
    trackingMessage('watch-setup-message', !search && !link.listingEnabled
      ? 'Для отдельных объявлений нужен подключённый источник. Сейчас сохранить объявление нельзя.' : '');
    field.blur();
    await openPage('watch-setup-view');
    $('watch-setup-title').focus({ preventScroll: true });
  } catch (error) {
    trackingMessage('watch-entry-message', error.message, true);
  } finally {
    setActionBusy(button, false);
  }
}

async function saveTrackingLink(form) {
  const link = state.trackingDraft;
  const button = $('watch-setup-save');
  if (!link || button.disabled) return;
  const name = form.elements.name.value;
  setActionBusy(button, true);
  trackingMessage('watch-setup-message', '');
  let result;
  try {
    result = link.kind === 'search'
      ? await api('search-watches', 'POST', { sourceUrl: link.url, name, ...savedSearchSettings(form) })
      : await api('watches', 'POST', { url: link.url, name });
  } catch (error) {
    trackingMessage('watch-setup-message', error.message, true);
    return;
  } finally {
    setActionBusy(button, false);
  }
  if (state.trackingDraft !== link || state.page !== 'watch-setup-view') return;
  state.trackingDraft = null;
  $('watch-url').value = '';
  document.activeElement.blur();
  trackingMessage('watch-entry-message', link.kind === 'search' ? searchSavedText(result)
    : result.added ? 'Объявление добавлено.' : 'Это объявление уже отслеживается.');
  await openPage('watch-view');
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
  const list = $('saved-search-list');
  const data = await (state.savedSearchSnapshot
    ? api('search-watches') : loadList('search-watches', list, 'savedSearches', request));
  if (state.requests.savedSearches !== request) return;
  const snapshot = JSON.stringify(data);
  if (snapshot === state.savedSearchSnapshot) return;
  state.savedSearchSnapshot = snapshot;
  state.searchData = data;
  renderTrackingOverview();
  const city = $('saved-search-city');
  const current = city.value;
  city.replaceChildren(...Object.entries(data.cities).map(([key, label]) => new Option(label, key)));
  if (Object.hasOwn(data.cities, current)) city.value = current;
  const configuredCount = data.rows.filter(row => row.new_enabled || row.drop_enabled).length;
  const limit = 'Поисков с включёнными уведомлениями: ' + configuredCount + ' из ' + data.plan.searchLimit + '.';
  $('saved-search-summary').textContent = !data.enabled && !data.linkEnabled
    ? 'Можно сохранять поиски и выбирать уведомления. Без источника проверки не выполняются. ' + limit
    : limit;
  const open = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.activity));
  list.replaceChildren(...data.rows.map(row => {
    const card = element('article', 'card saved-search-card');
    const remove = element('button', 'secondary', 'Удалить поиск');
    remove.type = 'button';
    remove.addEventListener('click', () => run(async () => {
      setActionBusy(remove, true);
      try {
        await api('search-watches', 'DELETE', { id: row.id });
        await loadSavedSearches();
        savedSearchMessage('Поиск удалён.');
      } finally {
        setActionBusy(remove, false);
      }
    }));
    if (row.source_url) {
      card.append(element('h3', '', searchTrackingName(row)));
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
      card.append(element('h3', '', searchTrackingName(row)));
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
    setActionBusy(save, true);
    try {
      const result = await api('favorite', 'PUT', { id: ad.id, saved: !ad.saved });
      ad.saved = result.saved;
      save.textContent = ad.saved ? '♥' : '♡';
      save.setAttribute('aria-pressed', ad.saved);
      if (state.page === 'saved') await loadAds(true);
    } catch (error) { notice(error.message); }
    finally { setActionBusy(save, false); }
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
      target.removeAttribute('aria-busy');
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
  setActionBusy(next, true);
  try {
    const data = await loadList('feed?' + query, target, key, request);
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
    if (state.requests[key] === request) setActionBusy(next, false);
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
  const video = $('watch-help-video');
  const videoUrl = profile.trackingHelpVideoUrl;
  video.hidden = !videoUrl;
  if (videoUrl) video.href = videoUrl;
  else video.removeAttribute('href');
  const signedOut = web && !profile.signedIn;
  $('nav').hidden = signedOut;
  $('avatar').hidden = signedOut;
  if (signedOut) {
    marketUi.reset();
    $('avatar').textContent = '→';
    state.requests.watches = state.requests.savedSearches = null;
    state.watchSnapshot = state.savedSearchSnapshot = null;
    state.watchData = state.searchData = state.trackingDraft = null;
    for (const id of ['watch-list', 'saved-search-list', 'watch-preview']) $(id).replaceChildren();
    $('watch-preview').hidden = $('watch-empty').hidden = true;
    $('watch-count').textContent = 'Загружаем отслеживания…';
    $('watch-plan-label').textContent = '';
    $('watch-url').value = '';
    trackingMessage('watch-entry-message', '');
    return;
  }
  $('avatar').textContent = [...profile.name][0]?.toLocaleUpperCase('ru') || '●';
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
}

function renderSubscription(profile) {
  const current = web ? (profile.expiresAt ? 'medium' : 'basic') : profile.monitoringPlanKey;
  $('plans-context').textContent = web ? 'Тарифы веб-поиска. Мониторинг в Telegram подключается отдельно.'
    : 'Тарифы мониторинга в Telegram. Текущий тариф назначает владелец Lotik.';
  $('plans-note').textContent = web ? 'Выдача в Lotik доступна при подключённом источнике.'
    : 'Интервалы указаны по настройкам тарифов. Проверки и уведомления требуют подключённого источника.';
  $('plans-current').textContent = 'Текущий тариф недоступен';
  $('plans-expiry').textContent = web && profile.expiresAt ? 'Действует до ' + dateFormat.format(profile.expiresAt * 1000)
    : current === 'basic' ? 'Бесплатный доступ без срока' : current ? 'Дата окончания не задана' : '';

  for (const card of $('plans').querySelectorAll('[data-plan]')) {
    const key = card.dataset.plan;
    const active = key === current;
    const radio = card.querySelector('input');
    radio.checked = active;
    card.toggleAttribute('data-current', active);
    card.querySelector('.plan-badge').hidden = !active;
    if (active) $('plans-current').textContent = 'Текущий тариф · ' + radio.labels[0].textContent.trim();
    const tier = profile.monitoringPlans?.[key];
    const features = web ? {
      basic: [profile.webPreviewLimit ? 'До ' + profile.webPreviewLimit + ' результатов на запрос' : 'Ограниченная выдача веб-поиска'],
      medium: ['Полная выдача веб-поиска'],
      fast: ['Условия веб-доступа пока не определены'],
    }[key] : tier ? [
      'Интервал проверки · ' + tier.label,
      'Поиски с уведомлениями · до ' + tier.searchLimit,
      'Уведомления о новых объявлениях и снижении цены',
    ] : ['Настройки тарифа недоступны'];
    card.querySelector('.plan-features').replaceChildren(...features.map(text => element('li', '', text)));
  }
}

async function loadOwnerOverview() {
  const owner = await api('owner');
  const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });
  $('balance').textContent = rubles.format(owner.netRub);
  $('accounts').textContent = money.format(owner.accounts);
  $('active-web-accounts').textContent = money.format(owner.activeWebAccounts);
  $('api-daily').textContent = money.format(owner.budget.today) + ' / ' + money.format(owner.budget.daily);
  $('api-monthly').textContent = money.format(owner.budget.month) + ' / ' + money.format(owner.budget.monthly);
  $('source').textContent = owner.liveFeed && owner.lastSync ? shortTime.format(owner.lastSync)
    : owner.liveFeed ? 'Ожидает загрузки' : 'Не подключена';
  $('owner-plans').replaceChildren(...owner.telegramPlans.map(({ name, total }) => {
    const row = element('div');
    row.append(element('dt', '', name), element('dd', '', money.format(total)));
    return row;
  }));
  const statuses = { pending: 'Ожидает оплаты', canceled: 'Отменён', succeeded: 'Оплачен' };
  $('owner-orders-empty').hidden = owner.orders.length > 0;
  $('owner-orders').replaceChildren(...owner.orders.map(order => {
    const row = element('li');
    const amount = rubles.format(order.amountMinor / 100);
    const status = order.refundedMinor >= order.amountMinor ? 'Полный возврат'
      : order.refundedMinor > 0 ? 'Частичный возврат ' + rubles.format(order.refundedMinor / 100)
        : statuses[order.status] ?? 'Статус неизвестен';
    row.append(
      element('strong', '', amount + ' · ' + status + (order.isTest ? ' · Тестовый' : '')),
      element('span', 'helper', 'Веб-профиль №' + order.accountId + ' · ' + shortTime.format(order.createdAt * 1000)),
    );
    return row;
  }));
  $('owner-history-empty').hidden = owner.planChanges.length > 0;
  $('owner-plan-history').replaceChildren(...owner.planChanges.map(change => {
    const row = element('li');
    const paused = change.pausedSearches ? ' · уведомления приостановлены у ' + change.pausedSearches + ' поисков' : '';
    row.append(
      element('strong', '', change.previousPlan + ' → ' + change.newPlan),
      element('span', 'helper', 'ID ' + change.userId + ' · ' + shortTime.format(change.changedAt * 1000) + paused),
    );
    return row;
  }));
  $('owner-overview').hidden = false;
}

function ownerUserMessage(message) {
  $('owner-user-message').textContent = message;
  $('owner-user-message').hidden = !message;
}

function updateOwnerPlanWarning() {
  const { user, plans } = ownerCustomer;
  const selected = plans.find(plan => plan.key === $('owner-plan-select').value);
  const paused = Math.max(0, user.enabledSearches - selected.searchLimit);
  $('owner-plan-save').disabled = selected.key === user.plan;
  $('owner-plan-warning').hidden = !paused || selected.key === user.plan;
  $('owner-plan-warning').textContent = 'Уведомления выключатся у ' + paused + ' поисков. Ссылки сохранятся.';
}

function renderOwnerCustomer(result) {
  ownerCustomer = result;
  const { user, plans } = result;
  $('owner-user-name').textContent = [user.name, user.username && '@' + user.username, 'ID ' + user.id].filter(Boolean).join(' · ');
  $('owner-user-searches').textContent = 'Поисков сохранено ' + user.savedSearches + ', с уведомлениями '
    + user.enabledSearches + '. Отдельных объявлений ' + user.savedListings + '.';
  $('owner-plan-select').replaceChildren(...plans.map(plan => new Option(plan.name, plan.key)));
  $('owner-plan-select').value = user.plan;
  $('owner-user-plan').hidden = false;
  updateOwnerPlanWarning();
}

async function submitOwnerForm(button, action) {
  const searchButton = $('owner-user-search').querySelector('button');
  const select = $('owner-plan-select');
  if (searchButton.disabled) return;
  searchButton.disabled = true;
  select.disabled = true;
  $('owner-plan-save').disabled = true;
  button?.setAttribute('aria-busy', 'true');
  ownerUserMessage('');
  try {
    await action();
  } catch (error) {
    ownerUserMessage(error.message);
  } finally {
    button?.removeAttribute('aria-busy');
    searchButton.disabled = false;
    select.disabled = false;
    if (ownerCustomer) updateOwnerPlanWarning();
  }
}

$('owner-user-search').addEventListener('submit', event => {
  event.preventDefault();
  void submitOwnerForm(event.submitter, async () => {
    ownerCustomer = undefined;
    $('owner-user-plan').hidden = true;
    const query = $('owner-user-query').value.trim();
    renderOwnerCustomer(await api('owner/user?' + new URLSearchParams({ q: query })));
  });
});

$('owner-plan-select').addEventListener('change', updateOwnerPlanWarning);
$('owner-user-plan').addEventListener('submit', event => {
  event.preventDefault();
  if (!ownerCustomer || $('owner-plan-save').disabled) return;
  void submitOwnerForm(event.submitter, async () => {
    const { user } = ownerCustomer;
    const plan = $('owner-plan-select').value;
    renderOwnerCustomer(await api('owner/user', 'POST', { userId: user.id, plan, expectedPlan: user.plan }));
    ownerUserMessage('Тариф сохранён.');
    if (user.id === state.profile?.telegramId) await refreshProfile().catch(error => notice(error.message));
    await loadOwnerOverview().catch(error => notice(error.message));
  });
});

async function openPage(page) {
  if (!state.profile || page === 'account' || page === 'plans') await refreshProfile();
  if (web && !state.profile.signedIn) page = 'login-view';
  state.page = page;
  if (page !== 'watch-setup-view') state.trackingDraft = null;
  notice('');
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== page;
  for (const button of document.querySelectorAll('.nav [data-page]')) {
    if (button.dataset.page === page || (button.dataset.page === 'watch-view' && ['watch-setup-view', 'watch-list-view'].includes(page))
      || (button.dataset.page === 'market' && ['market-editor', 'market-detail'].includes(page))) {
      button.setAttribute('aria-current', 'page');
    }
    else button.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (page === 'watch-view' || page === 'watch-list-view') {
    if (page === 'watch-view') state.watchPage = 1;
    try {
      await Promise.all([loadWatches(), loadSavedSearches()]);
      renderTrackingOverview();
    } catch (error) {
      $('watch-count').textContent = 'Не удалось обновить список.';
      throw error;
    }
  }
  if (page === 'feed') {
    setupSearch();
    await loadAds();
  }
  await marketUi.enter(page);
  if (page === 'saved' && marketUi.avitoFavorite) await loadAds(true);
  if (page === 'plans') renderSubscription(state.profile);
  if (page === 'account' && state.profile.isOwner) await loadOwnerOverview();
}

function run(callback) {
  void callback().catch(error => notice(error.message));
}

const marketUi = createMarketUi({ api, element, openPage, notice, run, setActionBusy, tg, initData, web });
$('favorite-market').addEventListener('click', () => run(() => marketUi.selectFavorite('market')));
$('favorite-avito').addEventListener('click', () => run(async () => {
  await marketUi.selectFavorite('avito');
  await loadAds(true);
}));

for (const button of document.querySelectorAll('[data-page]')) {
  button.addEventListener('click', () => run(() => openPage(button.dataset.page)));
}
$('avatar').addEventListener('click', () => run(() => openPage('account')));
$('watch-help-open').addEventListener('pointerdown', event => {
  // Keep the keyboard from moving the opener before the browser dispatches the click.
  if (document.activeElement === $('watch-url')) event.preventDefault();
});
$('watch-help-open').addEventListener('click', event => {
  const dialog = $('watch-help');
  if (dialog.open) return;
  event.currentTarget.focus({ preventScroll: true });
  dialog.showModal();
});
$('watch-help-video').addEventListener('click', event => {
  const url = state.profile?.trackingHelpVideoUrl;
  if (url && initData && tg.openTelegramLink) {
    tg.openTelegramLink(url);
    event.preventDefault();
  }
});
$('watch-form').addEventListener('submit', event => {
  event.preventDefault();
  run(setupTrackingLink);
});
$('watch-setup-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  run(() => saveTrackingLink(form));
});
$('watch-setup-link').addEventListener('click', event => {
  if (initData && tg.openLink && state.trackingDraft) {
    event.preventDefault();
    tg.openLink(state.trackingDraft.url);
  }
});
$('saved-search-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  run(async () => {
    const button = $('save-search');
    setActionBusy(button, true);
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
      setActionBusy(button, false);
    }
  });
});
$('watch-url').addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text/plain').trim();
  if (!text) return;
  event.preventDefault();
  $('watch-url').value = text;
  run(setupTrackingLink);
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
  if (state.page === 'watch-list-view') updateWatchCountdowns();
}, 1000);
setInterval(() => {
  if (state.page === 'watch-list-view') {
    void loadWatches().catch(() => { $('watch-summary').textContent = 'Обновляем состояние отслеживания…'; });
    void loadSavedSearches().catch(() => {});
  }
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
    submit?.setAttribute('aria-busy', 'true');
    try {
      await api(kind, 'POST', fields);
      form.reset();
      await refreshProfile();
      await openPage('watch-view');
    } finally {
      submit?.removeAttribute('aria-busy');
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
