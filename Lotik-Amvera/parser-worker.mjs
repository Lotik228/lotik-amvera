import { readParserConfig } from './parser-config.mjs';
import { runParser } from './parser-loop.mjs';

const { mode } = readParserConfig();
const endpoint = process.env.PARSER_DB_URL || 'http://127.0.0.1:8091';
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });

async function dbRequest(path, payload) {
  const response = await fetch(new URL(path, endpoint), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: payload == null ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('DB HTTP ' + response.status);
  return response.json();
}

await runParser({
  mode,
  stopping: () => stopping,
  claim: () => dbRequest('/claim'),
  finish: async payload => (await dbRequest('/finish', payload)).accepted,
});
