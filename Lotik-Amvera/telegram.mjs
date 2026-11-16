import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyInitData(raw, token, now = Math.floor(Date.now() / 1000)) {
  if (typeof raw !== 'string' || !raw || raw.length > 8192 || typeof token !== 'string' || !token) return null;
  const data = new URLSearchParams(raw);
  if (new Set(data.keys()).size !== data.size) return null;
  if ([...data].some(([key, value]) => !/^[a-z][a-z0-9_]*$/.test(key) || /[\r\n]/.test(value))) return null;
  const hash = data.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash ?? '')) return null;
  data.delete('hash');
  data.sort();
  const check = [...data].map(([key, value]) => key + '=' + value).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const signedDate = data.get('auth_date');
  if (!/^\d+$/.test(signedDate ?? '')) return null;
  const authDate = Number(signedDate);
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 3600) return null;
  try {
    const user = JSON.parse(data.get('user'));
    if (Number.isSafeInteger(user?.id) && user.id > 0 && typeof user.first_name === 'string'
      && (user.last_name == null || typeof user.last_name === 'string')
      && (user.username == null || typeof user.username === 'string')) return user;
  } catch {
    return null;
  }
  return null;
}

export function telegramClient(token, testMode = false) {
  const api = 'https://api.telegram.org/bot' + token + (testMode ? '/test/' : '/');
  return async (method, body = {}) => {
    let response;
    let result;
    try {
      response = await fetch(api + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      result = await response.json();
    } catch {
      throw new Error('Telegram API unavailable: ' + method);
    }
    if (!response.ok || !result.ok) {
      throw Object.assign(new Error('Telegram API rejected: ' + method + ' (' + response.status + ')'), {
        telegramCode: result.error_code ?? response.status,
        retryAfter: result.parameters?.retry_after,
      });
    }
    return result.result;
  };
}
