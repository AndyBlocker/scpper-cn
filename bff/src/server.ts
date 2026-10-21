import 'dotenv/config';
import { createServer } from './start.js';

const port = Number(process.env.PORT || 4396);
// Loopback by default: every consumer (nuxt proxy, openresty, user-backend) dials 127.0.0.1.
const host = process.env.BFF_HOST || '127.0.0.1';

async function main() {
  const app = await createServer();
  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`BFF listening on http://${host}:${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error starting server:', err);
  process.exit(1);
});


