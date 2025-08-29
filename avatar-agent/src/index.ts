import { buildServer } from "./server.js";
import { cfg } from "./config.js";
import { log } from "./logger.js";

const app = await buildServer();
app.listen({ host: cfg.host, port: cfg.port })
  .then(addr => log.info({ addr }, "avatar-agent started"))
  .catch(err => {
    log.error(err, "failed to start");
    process.exit(1);
  });


