import { createApp } from "./app.js";
import { config } from "./config.js";
import { db, rows } from "./db.js";
import { createWorker } from "./worker.js";
await rows("SELECT 1 FROM users LIMIT 1");
const app = await createApp(),
  worker = createWorker();
const server = app.listen(config.port, "0.0.0.0", () =>
  console.log("ChatYemot listening on port " + config.port),
);
await worker.start();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 20000);
  force.unref();
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    worker.stop(),
  ]);
  await db.end();
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
