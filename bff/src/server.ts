import 'dotenv/config';
import { createServer } from './start.js';

const port = Number(process.env.PORT || 4396);

async function main() {
  const app = await createServer();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`BFF listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error starting server:', err);
  process.exit(1);
});


