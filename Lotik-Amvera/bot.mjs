import { addWatches, extractLinks, extractMessageLinks, listWatches, plans, removeWatch, setPlan, userPlan, watchStatus } from './watches.mjs';
import { hasLookup, linkOptions } from './watch-worker.mjs';
import { linkSourceState, parseSearchUrl, saveSearch } from './saved-searches.mjs';

function tariffLine(db, userId) {
  const plan = userPlan(db, userId);
  return 'Тариф «' + plan.name + '» · интервал проверки ' + plan.label;
}

export async function handleBotUpdate(db, telegram, config, update, now) {
  const message = update.message;
  if (!message || message.chat?.type !== 'private' || !Number.isSafeInteger(message.from?.id) || message.from.id <= 0) return;
  const userId = message.from.id;
  const words = (message.text ?? '').trim().split(/\s+/);
  const command = words[0].split('@')[0];
  const args = words.slice(1);
  const send = (text, extra) => telegram('sendMessage', {
    chat_id: message.chat.id, text, link_preview_options: linkOptions, ...extra,
  });

  if (command === '/start') {
    return send('Пришлите ссылку на поиск или объявление Авито. Автоматические проверки работают при подключённом источнике данных.\n\n' + tariffLine(db, userId), {
      reply_markup: { inline_keyboard: [[{ text: 'Открыть Лотик', web_app: { url: config.publicUrl } }]] },
    });
  }
  if (command === '/paysupport' || command === '/support') {
    return send('Поддержка · ' + config.support);
  }
  if (command === '/id') return send('Ваш Telegram ID · ' + userId);
  if (command === '/tariff') {
    if (!args.length || userId !== config.owner) {
      const list = Object.values(plans).map(plan => plan.name + ' · ' + plan.label);
      return send(tariffLine(db, userId) + '\n\n' + list.join('\n'));
    }
    const [id, plan] = args;
    const customer = Number(id);
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(customer) || customer <= 0 || !setPlan(db, customer, plan, now)) {
      return send('Используйте /tariff TELEGRAM_ID basic|medium|fast');
    }
    return send('Пользователь ' + customer + '\n' + tariffLine(db, customer));
  }
  if (command === '/watches') {
    const page = /^\d{1,6}$/.test(args[0]) ? Math.max(1, Number(args[0])) : 1;
    const { rows, hasNext } = listWatches(db, userId, page);
    if (!rows.length) return send(page === 1 ? 'Нет отслеживаемых объявлений. Пришлите ссылку Авито.' : 'На этой странице объявлений нет.');
    const lines = rows.map(row => {
      const title = row.last_title ? row.last_title.slice(0, 80) + ' · ' : '';
      return title + '№ ' + row.listing_id + ' · ' + watchStatus(row);
    });
    const next = hasNext ? '\nСледующая страница /watches ' + (page + 1) : '';
    return send(tariffLine(db, userId) + '\n\n' + lines.join('\n')
      + '\n\nЧтобы остановить проверку, отправьте /unwatch ID_объявления' + next);
  }
  if (command === '/unwatch') {
    const removed = removeWatch(db, userId, args[0]);
    return send(removed === null ? 'Укажите ссылку или ID объявления после /unwatch.'
      : removed ? 'Отслеживание остановлено.' : 'Этого объявления нет в вашем списке.');
  }

  const listings = extractLinks(message);
  if (!listings.length) {
    const search = extractMessageLinks(message).find(value => parseSearchUrl(value));
    if (search) {
      try {
        const saved = saveSearch(db, userId, { sourceUrl: search, newEnabled: true, dropEnabled: false }, now, { allowSaveOnly: true });
        const source = linkSourceState(db, config.parserMode === 'live');
        const status = source === 'off' ? 'Источник не подключён. Проверки не выполняются.'
          : source === 'paused' ? 'Источник приостановлен. Проверки не выполняются.' : '';
        const settings = saved.notificationsEnabled ? 'Настройки уведомлений доступны в Лотике.'
          : 'Уведомления для этого поиска выключены. Включить их можно в Лотике в пределах тарифа.';
        return send([saved.alreadySaved ? 'Поиск уже сохранён.' : 'Поиск сохранён.', status, settings].filter(Boolean).join('\n'));
      } catch (error) {
        if ([400, 409].includes(error.status)) return send(error.message);
        throw error;
      }
    }
  }
  if (!listings.length) return send('Пришлите ссылку на поиск или прямую ссылку на объявление Авито.');
  if (!hasLookup(config)) return send('Источник данных для отслеживания пока не подключён. Попробуйте позже.');
  const added = addWatches(db, userId, listings, now);
  const plan = userPlan(db, userId);
  return send(added
    ? 'Добавлено в отслеживание: ' + added + '\n' + tariffLine(db, userId)
      + '\nПервая проверка через ' + plan.label + '.\nСписок /watches'
    : 'Эти объявления уже отслеживаются. Список /watches.');
}
