import { backup } from 'node:sqlite';
import { openStore } from './store.mjs';

const [command, destination] = process.argv.slice(2);
if (!['status', 'resume', 'backup'].includes(command) || (command === 'backup' && !destination)) {
  throw new Error('Usage: node parser-admin.mjs status | resume | backup FILE');
}
const db = openStore(process.env.DATA_DIR || './data');
try {
  if (command === 'resume') {
    db.prepare('UPDATE parser_state SET paused_reason = NULL, failures = 0 WHERE id = 1 AND paused_reason IS NOT NULL').run();
  }
  if (command === 'backup') {
    await backup(db, destination);
  } else {
    const state = db.prepare('SELECT source_mode, paused_reason, next_request_at, failures FROM parser_state WHERE id = 1').get();
    const { listings } = db.prepare('SELECT COUNT(*) AS listings FROM parser_listings').get();
    console.log(JSON.stringify({ ...state, listings, next_request_at: new Date(state.next_request_at * 1000).toISOString() }));
  }
} finally {
  db.close();
}
