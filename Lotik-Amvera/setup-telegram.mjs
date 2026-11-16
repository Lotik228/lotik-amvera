import { readConfig } from './config.mjs';
import { telegramClient } from './telegram.mjs';

const config = readConfig();
const call = telegramClient(config.token, config.telegramTest);
const bot = await call('getMe');
await call('setMyName', { name: 'Лотик' });
await call('setWebhook', {
  url: config.publicUrl + '/telegram/webhook',
  secret_token: config.secret,
  allowed_updates: ['message'],
});
await call('setChatMenuButton', {
  menu_button: { type: 'web_app', text: 'Лотик', web_app: { url: config.publicUrl } },
});
await call('setMyCommands', {
  commands: [
    { command: 'start', description: 'Открыть Лотик' },
    { command: 'watches', description: 'Мои отслеживаемые объявления' },
    { command: 'unwatch', description: 'Остановить отслеживание по ссылке или ID' },
    { command: 'tariff', description: 'Текущий тариф и интервалы проверок' },
    { command: 'id', description: 'Мой Telegram ID' },
    { command: 'support', description: 'Связаться с поддержкой' },
  ],
});
console.log('Webhook и меню настроены. Откройте https://t.me/' + bot.username + ' и отправьте /start.');
