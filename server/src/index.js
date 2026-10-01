import { createApp } from './http/app.js';
import { createMemoryStore } from './db/memory-store.js';
import { createPgStore } from './db/pg-store.js';

async function main() {
  const store = process.env.USE_PG === '1'
    ? await createPgStore(process.env.DATABASE_URL)
    : createMemoryStore();
  const app = createApp(store);
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`ResumeForge listening on :${port} (store=${store.kind})`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
