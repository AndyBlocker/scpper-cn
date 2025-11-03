#!/usr/bin/env node

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.join(__dirname, '..', 'backend');

function run(command) {
  console.log(`\n>>> ${command}`);
  execSync(command, { stdio: 'inherit', cwd: backendDir });
}

const args = process.argv.slice(2);
const sinceIndex = args.indexOf('--since');
const sinceExplicit = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;
const sinceDate = sinceExplicit ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);

console.log(`Processing deleted pages created since ${sinceDate}`);

const commands = [
  `npm run import:legacy-pages -- --since ${sinceDate}`,
  `npm run merge:deleted-page-versions -- --since ${sinceDate}`,
  `npm run fix:deleted-ratings -- --since ${sinceDate}`,
  `npm run backfill:deleted-revisions -- --since ${sinceDate}`
];

for (const command of commands) {
  run(command);
}
