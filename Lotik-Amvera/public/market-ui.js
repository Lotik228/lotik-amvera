function createMarketUi({ api, element, openPage, notice, run, setActionBusy, tg, initData, web }) {
  const el = id => document.getElementById(id);
  const currency = new Intl.NumberFormat('ru-RU');
  const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });
  const labels = { pending: 'На проверке', active: 'Активно', sold: 'Продано', removed: 'Снято', rejected: 'Отклонено' };
  const targets = {
    market: ['ads', 'market-feed', 'market-feed-more', 'Объявлений пока нет. Можно разместить первое.'],
    'market-mine': ['mine', 'market-mine-list', 'market-mine-more', 'У вас пока нет объявлений.'],
    'market-moderation': ['moderation', 'market-moderation-list', 'market-moderation-more', 'В этой очереди пока пусто.'],
    saved: ['favorites', 'market-favorites-list', 'market-favorites-more', 'Сохранённые товары Маркета появятся здесь.'],
  };
  const pagers = new Map();
  let activePage;
  let activeDetail;
  let editor;
  let favoriteTab = 'market';
  let gallery = new Map();

  function route(path) { return 'market/' + path; }
  function priceLabel(price) { return price === 0 ? 'Бесплатно' : currency.format(price) + ' ₽'; }
  function button(text, action, className = 'secondary') {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', () => run(async () => action(node)));
    return node;
  }

  function resetImages() {
    for (const entry of gallery.values()) {
      entry.then(url => URL.revokeObjectURL(url)).catch(() => {});
    }
    gallery = new Map();
  }

  function reset() {
    activeDetail = null;
    editor = null;
    favoriteTab = 'market';
    el('market-web-code').textContent = '';
    el('market-web-code').hidden = true;
    el('market-link-redeem').reset();
    pagers.clear();
    resetImages();
  }

  async function binary(path, method = 'GET', file) {
    const prefix = web ? '/web/api/' : '/api/';
    const response = await fetch(prefix + route(path), {
      method, body: file,
      headers: { ...(!web && { 'X-Telegram-Init-Data': initData }), ...(file && { 'Content-Type': 'application/octet-stream' }) },
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Фото недоступно.');
    }
    return file ? response.json() : response.blob();
  }

  function photo(id, privatePhoto = false, className = '', alt = '') {
    if (!id) return element('span', 'market-placeholder', '◇');
    const image = element('img', className);
    image.alt = alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    if (!privatePhoto) image.src = '/market-photo/' + id;
    else {
      if (!gallery.has(id)) gallery.set(id, binary('photos/' + id).then(blob => URL.createObjectURL(blob)));
      gallery.get(id).then(src => { image.src = src; }).catch(() => { image.alt = 'Фото недоступно'; });
    }
    return image;
  }

  async function loadMeta() {
    const data = await api(route('meta'));
    for (const [id, text] of [['market-search-category','Все категории'],['market-edit-category','Выберите категорию']]) {
      const select = el(id);
      const previous = select.value;
      select.replaceChildren(new Option(text,''), ...data.categories.map(row => new Option(row.name,row.id)));
      if (data.categories.some(row => row.id === previous)) select.value = previous;
    }
    el('market-cities').replaceChildren(...data.cities.map(city => new Option(city)));
    return data;
  }

  function card(row, page) {
    const panel = element('article', 'market-item');
    const privateView = page === 'market-mine' || page === 'market-moderation';
    const entry = button('', () => showDetail(row.id, page), 'market-item-open');
    const published = row.publishedAt ?? row.createdAt;
    const extra = privateView ? labels[row.status] : date.format(published * 1000);
    entry.append(photo(row.cover, privateView, 'market-cover'), element('span','market-item-title',row.title),
      element('span','market-item-price',priceLabel(row.price)), element('span','market-item-meta',row.city + ' · ' + extra));
    panel.append(entry);
    if (!privateView && !row.own) {
      const favorite = button(row.saved ? '♥' : '♡', async control => {
        control.disabled = true;
        try {
          const result = await api(route('ads/' + row.id + '/favorite'), 'PUT', { saved: !row.saved });
          row.saved = result.saved;
          control.textContent = row.saved ? '♥' : '♡';
          control.setAttribute('aria-pressed', row.saved);
          if (page === 'saved' && !row.saved) panel.remove();
          if (page === 'saved' && !el('market-favorites-list').childElementCount) await renderList('saved');
        } finally { control.disabled = false; }
      }, 'heart');
      favorite.setAttribute('aria-label', 'Избранное · ' + row.title);
      favorite.setAttribute('aria-pressed', Boolean(row.saved));
      panel.append(favorite);
    }
    return panel;
  }

  async function renderList(page, append = false) {
    const [path, id, moreId, empty] = targets[page];
    const target = el(id);
    const more = el(moreId);
    const previous = pagers.get(page);
    if (append && !previous?.next) return;
    let params = new URLSearchParams();
    if (append) params = new URLSearchParams(previous.params);
    else if (page === 'market') params = new URLSearchParams(new FormData(el('market-filters')));
    else if (page === 'market-moderation') params.set('queue', el('market-moderation-queue').value);
    const state = { params: params.toString() };
    pagers.set(page, state);
    if (append) params.set('cursor', previous.next);
    else target.replaceChildren(...Array.from({ length: 4 }, () => element('div','market-skeleton')));
    target.setAttribute('aria-busy','true');
    more.disabled = true;
    try {
      const data = await api(route(path + '?' + params));
      if (pagers.get(page) !== state || activePage !== page) return;
      if (!append) target.replaceChildren();
      if (data.rows.length) target.append(...data.rows.map(row => card(row, page)));
      else if (!append) target.append(element('p','empty',empty));
      state.next = data.next;
      more.hidden = !state.next;
    } catch (error) {
      if (pagers.get(page) === state && activePage === page) {
        if (!append) target.replaceChildren(element('p','empty',error.message));
        else { state.next = previous.next; notice(error.message); }
      }
    } finally {
      if (pagers.get(page) === state) {
        target.removeAttribute('aria-busy');
        more.disabled = false;
      }
    }
  }

  async function openEditor(ad) {
    const info = await loadMeta();
    if (!info.linked) {
      await openPage('account');
      notice('Для публикации подтвердите Telegram в кабинете.');
      el('market-link-generate').focus();
      return;
    }
    if (info.blocked) throw new Error('Действия в Маркете ограничены модератором.');
    editor = { ad, photos: ad?.photos.slice() ?? [], uploading: false };
    const form = el('market-editor-form');
    form.reset();
    el('market-editor-title').textContent = ad ? 'Редактировать объявление' : 'Новое объявление';
    el('market-editor-back').textContent = ad ? '← Мои объявления' : '← Маркет';
    const choice = el('market-contact-choice');
    choice.replaceChildren(new Option('Через бота Lotik','bot'));
    if (info.username) choice.append(new Option('Показывать @' + info.username, 'username'));
    if (ad) {
      for (const name of ['title','price','category','city','district','description']) form.elements[name].value = ad[name];
      choice.value = ad.contact === 'username' && info.username ? 'username' : 'bot';
    }
    el('market-editor-save').disabled = false;
    el('market-photo-input').disabled = false;
    await openPage('market-editor');
    renderDraft();
  }

  function renderDraft() {
    if (!editor) return;
    const draft = editor;
    el('market-photo-draft').replaceChildren(...draft.photos.map((id,index) => {
      const frame = element('figure','');
      const controls = element('div','market-photo-controls');
      const change = direction => {
        const selected = draft.photos.splice(index,1)[0];
        draft.photos.splice(index+direction,0,selected);
        renderDraft();
      };
      const back = button('←', () => change(-1));
      const next = button('→', () => change(1));
      back.setAttribute('aria-label','Передвинуть фото ' + (index+1) + ' влево');
      next.setAttribute('aria-label','Передвинуть фото ' + (index+1) + ' вправо');
      back.disabled = index === 0;
      next.disabled = index === draft.photos.length - 1;
      controls.append(back,next,button('×', () => {
        draft.photos.splice(index,1);
        renderDraft();
      }));
      controls.lastChild.setAttribute('aria-label','Убрать фото ' + (index+1));
      frame.append(photo(id,true,'','Фото ' + (index+1)), element('figcaption','helper',index ? 'Фото ' + (index+1) : 'Обложка'),controls);
      return frame;
    }));
  }

  async function compress(file) {
    if (file.size > 30 * 1024 * 1024) throw new Error('Слишком большой исходный файл. Выберите фото до 30 МБ.');
    const header = new Uint8Array(await file.slice(0,16).arrayBuffer());
    const kind = String.fromCharCode(...header);
    if (!(header[0] === 255 && header[1] === 216) && !kind.startsWith('\x89PNG')
      && !(kind.startsWith('RIFF') && kind.slice(8,12) === 'WEBP') && kind.slice(4,8) !== 'ftyp') {
      throw new Error('Выберите JPEG, PNG, WebP или HEIC, который умеет читать ваше устройство.');
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      try { await image.decode(); } catch {
        if (file.size <= 6 * 1024 * 1024) return file;
        throw new Error('Устройство не смогло прочитать фото. Выберите JPEG, PNG или WebP.');
      }
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 64_000_000) throw new Error('Слишком большое разрешение фото.');
      const scale = Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1,Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const result = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.88));
      if (!result) throw new Error('Не получилось подготовить фото.');
      return result;
    } finally { URL.revokeObjectURL(url); }
  }

  async function showDetail(id, page) {
    activeDetail = { id, page };
    await openPage('market-detail');
  }

  function openTelegram(url, event) {
    if (initData && tg?.openTelegramLink) {
      tg.openTelegramLink(url);
      event.preventDefault();
    }
  }

  function messageForm(title, label, limit, submit, messageKey, success) {
    const details = element('details','card market-extra');
    const form = element('form','market-form');
    const field = element('textarea','');
    field.rows = 3;
    field.required = true;
    field.maxLength = limit;
    const caption = element('label','',label);
    caption.append(field);
    const send = element('button','primary',title);
    form.append(caption,send);
    form.addEventListener('submit',event => {
      event.preventDefault();
      run(async () => {
        if (send.disabled) return;
        setActionBusy(send,true);
        try {
          await submit({ [messageKey]: field.value });
          details.open = false;
          form.reset();
          notice(success);
        } finally { setActionBusy(send,false); }
      });
    });
    details.append(element('summary','',title),form);
    return details;
  }

  function ownerActions(ad, page) {
    const controls = element('div','market-actions');
    const actions = [];
    if (ad.status !== 'sold') controls.append(button('Редактировать', () => openEditor(ad)));
    if (['active','pending'].includes(ad.status)) actions.push(['Снять с публикации','remove']);
    if (['active','removed'].includes(ad.status)) actions.push(['Отметить проданным','sold']);
    if (['removed','rejected'].includes(ad.status)) actions.push(['Повторно на проверку','republish']);
    actions.push(['Удалить','delete']);
    for (const [label,action] of actions) controls.append(button(label, async control => {
      if (action === 'delete' && !window.confirm('Удалить объявление и его фотографии?')) return;
      setActionBusy(control,true);
      try {
        await api(route('ads/' + ad.id + '/status'),'POST',{ action, revision: ad.revision });
        await openPage(page);
        notice('Статус обновлён.');
      } finally { setActionBusy(control,false); }
    }));
    return controls;
  }

  function moderationActions(ad) {
    const panel = element('section','card market-form');
    const input = element('input','');
    input.maxLength = 300;
    const label = element('label','','Причина решения');
    label.append(input);
    panel.append(element('h2','','Решение модератора'),label);
    for (const report of ad.reports) panel.append(element('p','watch-message',report.reason));
    const actions = [];
    if (ad.status === 'pending' && !ad.blocked) actions.push(['Одобрить','approve']);
    if (['pending','active'].includes(ad.status)) actions.push(['Отклонить','reject'],['Скрыть','remove']);
    actions.push(['Удалить','delete'], ad.blocked ? ['Снять блокировку','unblock'] : ['Заблокировать продавца','block']);
    if (ad.reports.length) actions.push(['Закрыть жалобы','resolve']);
    const buttons = element('div','market-actions');
    for (const [title,action] of actions) buttons.append(button(title, async control => {
      if (['delete','block'].includes(action) && !window.confirm(title + '?')) return;
      setActionBusy(control,true);
      try {
        await api(route('moderation/' + ad.id), 'POST', { action, revision: ad.revision, note: input.value });
        await openPage('market-moderation');
        notice('Решение сохранено.');
      } finally { setActionBusy(control,false); }
    }, action === 'approve' ? 'primary' : 'secondary'));
    panel.append(buttons);
    return panel;
  }

  async function renderDetail() {
    const selection = activeDetail;
    if (!selection) return;
    const { id, page } = selection;
    const target = el('market-detail-body');
    target.replaceChildren(element('p','helper','Загружаем объявление…'));
    const owner = page === 'market-mine';
    const moderation = page === 'market-moderation';
    const privatePhoto = owner || moderation;
    const path = moderation ? 'moderation/' + id : 'ads/' + id + (owner ? '/edit' : '');
    const ad = await api(route(path));
    if (activePage !== 'market-detail' || activeDetail !== selection) return;
    const panel = element('article','card market-detail-card');
    const gallery = element('div','market-detail-gallery');
    for (const [i,key] of ad.photos.entries()) gallery.append(photo(key,privatePhoto,'','Фото ' + (i+1) + ' · ' + ad.title));
    panel.append(element('h1','',ad.title),element('h2','',priceLabel(ad.price)),
      element('p','helper',[ad.city,ad.district,privatePhoto ? labels[ad.status] : date.format(ad.publishedAt*1000)].filter(Boolean).join(' · ')));
    if (ad.photos.length) panel.append(gallery);
    panel.append(element('p','market-description',ad.description));
    if (ad.moderationNote) panel.append(element('p','watch-message',ad.moderationNote));
    if (owner) panel.append(ownerActions(ad,page));
    if (!privatePhoto && !ad.own) {
      if (ad.telegramUrl) {
        const link = element('a','primary','Написать продавцу');
        link.href = ad.telegramUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.addEventListener('click',event => openTelegram(ad.telegramUrl,event));
        panel.append(link);
      } else {
        panel.append(messageForm('Написать продавцу','Сообщение продавцу',800,
          payload => api(route('ads/' + ad.id + '/contact'),'POST',payload),'message','Сообщение отправлено через бота.'),
        element('p','helper','Ответ придёт в чат с ботом Lotik. Для переписки нажмите «Старт» в чате с ботом.'));
      }
      panel.append(messageForm('Пожаловаться','Почему объявление требует проверки?',350,
        payload => api(route('ads/' + ad.id + '/report'),'POST',payload),'reason','Жалоба отправлена модератору.'));
    }
    target.replaceChildren(panel);
    if (moderation) target.append(moderationActions(ad));
  }

  async function showFavorites() {
    el('saved-avito').hidden = favoriteTab !== 'avito';
    el('saved-market').hidden = favoriteTab !== 'market';
    el('favorite-avito').setAttribute('aria-pressed',favoriteTab === 'avito');
    el('favorite-market').setAttribute('aria-pressed',favoriteTab === 'market');
    if (favoriteTab === 'market') await renderList('saved');
  }

  async function enter(page) {
    if (activePage !== page) resetImages();
    activePage = page;
    if (page === 'market') await Promise.all([loadMeta(),renderList(page)]);
    if (page === 'saved') await showFavorites();
    if (page === 'market-detail') await renderDetail();
    if (page === 'market-mine' || page === 'market-moderation') await renderList(page);
    if (page === 'account' && web) el('market-link-generate').hidden = (await loadMeta()).linked;
  }

  for (const id of ['market-create','market-mine-create']) el(id).addEventListener('click', () => run(() => openEditor()));
  el('market-detail-back').addEventListener('click', () => run(() => openPage(activeDetail?.page ?? 'market')));
  el('market-editor-back').addEventListener('click', () => run(() => openPage(editor?.ad ? 'market-mine' : 'market')));
  el('market-filters').addEventListener('submit', event => {
    event.preventDefault();
    run(() => renderList('market'));
  });
  el('market-moderation-queue').addEventListener('change', () => run(() => renderList('market-moderation')));
  for (const [page,[,,id]] of Object.entries(targets)) el(id).addEventListener('click', () => run(() => renderList(page,true)));
  el('market-photo-input').addEventListener('change', event => {
    const input = event.currentTarget;
    const files = [...input.files];
    input.value = '';
    run(async () => {
      const draft = editor;
      if (!draft || draft.uploading || !files.length) return;
      if (draft.photos.length + files.length > 5) throw new Error('На объявление можно добавить до пяти фото.');
      draft.uploading = true;
      input.disabled = true;
      const submit = el('market-editor-save');
      setActionBusy(submit,true);
      try {
        for (const file of files) {
          if (editor !== draft || activePage !== 'market-editor') break;
          const photo = await binary('photos','POST',await compress(file));
          draft.photos.push(photo.id);
          if (editor === draft && activePage === 'market-editor') renderDraft();
        }
      } finally {
        draft.uploading = false;
        if (editor === draft) {
          input.disabled = false;
          setActionBusy(submit,false);
        }
      }
    });
  });
  el('market-editor-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    run(async () => {
      const draft = editor;
      const save = el('market-editor-save');
      if (!draft || save.disabled) return;
      const values = Object.fromEntries(new FormData(form));
      const payload = { ...values, photos: draft.photos, acceptRules: form.elements.acceptRules.checked, revision: draft.ad?.revision };
      setActionBusy(save,true);
      try {
        await api(route(draft.ad ? 'ads/' + draft.ad.id + '/edit' : 'ads'), draft.ad ? 'PUT' : 'POST',payload);
        if (editor !== draft || activePage !== 'market-editor') return;
        editor = null;
        await openPage('market-mine');
        notice('Объявление отправлено на проверку.');
      } finally { if (!editor || editor === draft) setActionBusy(save,false); }
    });
  });
  el('market-link-generate').addEventListener('click', () => run(async () => {
    const result = await api(route('link'),'POST',{});
    const box = el('market-web-code');
    box.textContent = 'Код ' + result.code + '. Введите его в кабинете Mini App → «Связать с веб-аккаунтом». Код действует 10 минут.';
    box.hidden = false;
  }));
  el('market-link-redeem').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    run(async () => {
      await api(route('link'),'POST',{ code: form.elements.code.value, confirm: form.elements.confirm.checked });
      form.reset();
      notice('Веб-аккаунт связан с Telegram.');
    });
  });

  async function selectFavorite(tab) {
    favoriteTab = tab;
    await showFavorites();
  }

  return { enter, reset, selectFavorite, get avitoFavorite() { return favoriteTab === 'avito'; } };
}
