import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const sessionName = 'radar_web_session';
const sessionAge = 30 * 86400;
const hashToken = token => createHash('sha256').update(token).digest('hex');

export async function signIn(db, input, register) {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input?.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
    || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw Object.assign(new Error('Введите email и пароль длиной от 12 до 128 символов.'), { status: 400 });
  }
  if (register) {
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(password, salt, 32);
    const result = db.prepare('INSERT OR IGNORE INTO web_accounts (email, password_hash) VALUES (?, ?)')
      .run(email, salt + ':' + hash.toString('hex'));
    if (!result.changes) throw Object.assign(new Error('Аккаунт с этим email уже существует. Войдите.'), { status: 409 });
    return Number(result.lastInsertRowid);
  }
  const account = db.prepare('SELECT * FROM web_accounts WHERE email = ?').get(email);
  const [salt, expected] = account?.password_hash.split(':') ?? ['0'.repeat(32), '0'.repeat(64)];
  const hash = await derive(password, salt, 32);
  if (timingSafeEqual(hash, Buffer.from(expected, 'hex')) && account) return account.id;
  throw Object.assign(new Error('Проверьте email и пароль.'), { status: 401 });
}

function readSession(req) {
  const token = req.headers.cookie?.match(/(?:^|; *)radar_web_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token && hashToken(token);
}

function cookie(value, age, secure) {
  return sessionName + '=' + value + '; Path=/web/; HttpOnly; SameSite=Lax; Max-Age=' + age + (secure ? '; Secure' : '');
}

export function startSession(db, req, res, accountId, now, secure) {
  const token = randomBytes(32).toString('hex');
  const previous = readSession(req);
  if (previous) db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(previous);
  db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO web_sessions VALUES (?, ?, ?)').run(hashToken(token), accountId, now + sessionAge);
  res.setHeader('Set-Cookie', cookie(token, sessionAge, secure));
}

export function endSession(db, req, res, secure) {
  const previous = readSession(req);
  if (previous) db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(previous);
  res.setHeader('Set-Cookie', cookie('', 0, secure));
}

export function getAccount(db, req, now) {
  const token = readSession(req);
  if (!token) return null;
  return db.prepare(`
    SELECT web_accounts.id, web_accounts.email FROM web_sessions
    JOIN web_accounts ON web_accounts.id = web_sessions.account_id
    WHERE token_hash = ? AND expires_at > ?
  `).get(token, now);
}
