#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { ensureSharedNodeModules, findMainWorktree, getRepoRoot } from './shared-node-modules.mjs';

const [, , serviceName, binaryName, ...args] = process.argv;

if (!serviceName || !binaryName) {
  console.error('Usage: node scripts/service-bin-runner.mjs <service> <binary> [args...]');
  process.exit(1);
}

const repoRoot = getRepoRoot();
const mainWorktreePath = findMainWorktree();
const { cleanup } = ensureSharedNodeModules({
  repoRoot,
  mainWorktreePath,
  services: [serviceName]
});

const binaryPath = path.join(repoRoot, serviceName, 'node_modules', '.bin', binaryName);

const child = spawn(binaryPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
});

let cleanedUp = false;

function runCleanup() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  cleanup();
}

for (const eventName of ['SIGINT', 'SIGTERM']) {
  process.on(eventName, () => {
    child.kill(eventName);
  });
}

child.on('error', (err) => {
  runCleanup();
  console.error(err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  runCleanup();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
