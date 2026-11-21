import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { Application } from './models.js';
import { sweep } from './workflow.js';

await connectDb({ keepData: true });

// Applications saved by an older version of this project do not have the encrypted fields. Say so, instead of failing later.
const old = await Application.countDocuments({ secret: { $exists: false } });
if (old > 0) console.warn(`\nWARNING: ${old} saved application(s) come from an older version and cannot be opened.\nTo start fresh: stop the server, delete the .data folder, and start again.\n`);
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
