import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { migrateOldRecords } from './migrate.js';
import { sweep } from './workflow.js';

await connectDb({ keepData: true });

// Applications saved by an older version of this project are upgraded in place.
const upgraded = await migrateOldRecords();
if (upgraded > 0) console.log(`Upgraded ${upgraded} saved application(s) from an older version.`);

const server = createApp().listen(config.port, () => {
  console.log(`\nMerchant onboarding is running at http://localhost:${config.port}\n`);
});

// Stop cleanly on Ctrl+C so the built-in database is closed properly and the next start works.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { server.close(); await disconnectDb(); process.exit(0); });
}

// Once a second: look for work that is due (timeouts, retries, merchant IDs to create).
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try { await sweep(); } catch (e) { console.error('sweep failed:', e); } finally { running = false; }
}, 1000);
