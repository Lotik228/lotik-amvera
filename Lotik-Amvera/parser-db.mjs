import { createServer } from 'node:http';
import { openStore } from './store.mjs';
import { readParserConfig } from './parser-config.mjs';
import { claimParserJob, finishParserJob, initializeParserStorage } from './parser-jobs.mjs';

const config = readParserConfig();
const db = openStore(process.env.DATA_DIR || './data');
const now = () => Math.floor(Date.now() / 1000);
initializeParserStorage(db, config.mode);

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      db.prepare('SELECT 1').get();
      return reply(res, 200, { status: 'ok' });
    }
    if (req.method !== 'POST' || !['/claim', '/finish'].includes(req.url)) return reply(res, 404, {});
    if (config.mode === 'off') return reply(res, 409, { error: 'Parser disabled' });
    if (req.url === '/claim') return reply(res, 200, claimParserJob(db, now(), config.gap));
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 400_000) return reply(res, 413, { error: 'Payload too large' });
      chunks.push(chunk);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, {}); }
    return reply(res, 200, { accepted: finishParserJob(db, payload?.token, payload?.result, now()) });
  } catch (error) {
    console.error(JSON.stringify({ event: 'database_error', type: error.code ?? error.name }));
    reply(res, 500, { error: 'Storage rejected request' });
  }
});

server.listen(Number(process.env.PARSER_DB_PORT || 8091), process.env.PARSER_DB_HOST || '127.0.0.1',
  () => console.log(JSON.stringify({ event: 'database_ready', mode: config.mode })));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => db.close()));
