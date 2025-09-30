import { buildServer } from "./server.js";
import { cfg } from "./config.js";
import { log } from "./logger.js";
import { startImageCacheWorker } from "./image-cache/worker.js";

const app = await buildServer();
const imageWorker = await startImageCacheWorker();

async function shutdown() {
  try {
    await app.close();
  } catch (err) {
    log.error({ err }, "error while shutting down fastify");
  }
  try {
    await imageWorker.stop();
  } catch (err) {
    log.error({ err }, "error while stopping image worker");
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen({ host: cfg.host, port: cfg.port })
  .then(addr => log.info({ addr }, "avatar-agent started"))
  .catch(err => {
    log.error(err, "failed to start");
    void imageWorker.stop();
    process.exit(1);
  });
