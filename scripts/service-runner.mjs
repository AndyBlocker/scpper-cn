#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { ensureSharedNodeModules, findMainWorktree, getBranchName, getRepoRoot } from './shared-node-modules.mjs';

const [, , serviceName, action] = process.argv;

if (!serviceName || !action) {
  console.error('Usage: node scripts/service-runner.mjs <service> <action>');
  process.exit(1);
}

const SAFE_DEV_PORTS = {
  frontend: '19876',
  bff: '14396',
  'user-backend': '14455',
  'avatar-agent': '13200',
  'mail-agent': '13110'
};

const PROD_PORTS = {
  frontend: '9876',
  bff: '4396',
  'user-backend': '4455',
  'avatar-agent': '3200',
  'mail-agent': '3110'
};

const repoRoot = getRepoRoot();
const branch = getBranchName(repoRoot);
const mainWorktreePath = findMainWorktree(repoRoot);
const isProtectedMainWorktree = repoRoot === mainWorktreePath;
const allowProtected = process.env.SCPPER_ALLOW_PROTECTED === '1' || process.env.SCPPER_ALLOW_MAIN === '1';
const isProtectedBranch = branch === 'main' || branch === 'master';
const useProdDefaults = allowProtected && (isProtectedMainWorktree || isProtectedBranch);

if (!allowProtected && (isProtectedMainWorktree || isProtectedBranch)) {
  console.error(`Refusing to run '${serviceName}:${action}' inside protected checkout '${branch || repoRoot}'.`);
  console.error('Create a feature worktree first: bash scripts/dev-worktree.sh create feat/<topic>');
  console.error('If this is an intentional deployment or emergency run, retry with SCPPER_ALLOW_PROTECTED=1.');
  process.exit(1);
}

const commandTable = {
  frontend: {
    cwd: path.join(repoRoot, 'frontend'),
    actions: {
      dev: 'nuxt dev --port "$PORT" --host 0.0.0.0',
      build: 'nuxt build',
      start: 'nuxt start --port "$PORT" --host 0.0.0.0'
    },
    devEnv: {
      PORT: SAFE_DEV_PORTS.frontend,
      NITRO_PORT: SAFE_DEV_PORTS.frontend,
      BFF_BASE: '/api',
      BFF_PROXY_TARGET: `http://127.0.0.1:${SAFE_DEV_PORTS.bff}`
    },
    prodEnv: {
      PORT: PROD_PORTS.frontend,
      NITRO_PORT: PROD_PORTS.frontend,
      BFF_BASE: '/api',
      BFF_PROXY_TARGET: `http://127.0.0.1:${PROD_PORTS.bff}`
    }
  },
  bff: {
    cwd: path.join(repoRoot, 'bff'),
    actions: {
      dev: 'ts-node-dev --respawn --transpile-only src/server.ts',
      build: 'tsc -p tsconfig.json',
      start: 'node dist/server.js'
    },
    devEnv: {
      PORT: SAFE_DEV_PORTS.bff,
      ENABLE_CACHE: 'false',
      USER_BACKEND_BASE_URL: `http://127.0.0.1:${SAFE_DEV_PORTS['user-backend']}`,
      AVATAR_AGENT_BASE_URL: `http://127.0.0.1:${SAFE_DEV_PORTS['avatar-agent']}`
    },
    prodEnv: {
      PORT: PROD_PORTS.bff,
      ENABLE_CACHE: 'true',
      USER_BACKEND_BASE_URL: `http://127.0.0.1:${PROD_PORTS['user-backend']}`,
      AVATAR_AGENT_BASE_URL: `http://127.0.0.1:${PROD_PORTS['avatar-agent']}`
    }
  },
  'user-backend': {
    cwd: path.join(repoRoot, 'user-backend'),
    actions: {
      dev: 'ts-node-dev --respawn --transpile-only src/server.ts',
      build: 'tsc -p tsconfig.json',
      start: 'node dist/server.js'
    },
    devEnv: {
      USER_BACKEND_PORT: SAFE_DEV_PORTS['user-backend'],
      MAIL_AGENT_BASE_URL: `http://127.0.0.1:${SAFE_DEV_PORTS['mail-agent']}`
    },
    prodEnv: {
      USER_BACKEND_PORT: PROD_PORTS['user-backend'],
      MAIL_AGENT_BASE_URL: `http://127.0.0.1:${PROD_PORTS['mail-agent']}`
    }
  },
  'avatar-agent': {
    cwd: path.join(repoRoot, 'avatar-agent'),
    actions: {
      build: 'tsc -p tsconfig.json',
      start: 'node dist/index.js',
      dev: 'node --env-file=.env --watch --enable-source-maps dist/index.js',
      prune: 'node dist/scripts/prune.js'
    },
    devEnv: {
      PORT: SAFE_DEV_PORTS['avatar-agent'],
      AVATAR_ROOT: path.join(repoRoot, '.data/avatar-agent-dev/avatars'),
      PAGE_IMAGE_ROOT: path.join(repoRoot, '.data/avatar-agent-dev/page-images')
    },
    prodEnv: {
      PORT: PROD_PORTS['avatar-agent']
    }
  },
  'mail-agent': {
    cwd: path.join(repoRoot, 'mail-agent'),
    actions: {
      dev: 'node --watch src/server.mjs',
      start: 'node src/server.mjs'
    },
    devEnv: {
      MAIL_AGENT_PORT: SAFE_DEV_PORTS['mail-agent']
    },
    prodEnv: {
      MAIL_AGENT_PORT: PROD_PORTS['mail-agent']
    }
  }
};

const config = commandTable[serviceName];

if (!config) {
  console.error(`Unknown service: ${serviceName}`);
  process.exit(1);
}

const command = config.actions[action];

if (!command) {
  console.error(`Unknown action for ${serviceName}: ${action}`);
  process.exit(1);
}

const servicePath = config.cwd;
const servicePathBin = path.join(servicePath, 'node_modules', '.bin');
const rootBin = path.join(repoRoot, 'node_modules', '.bin');
const selectedEnv = useProdDefaults ? config.prodEnv : config.devEnv;
const { cleanup } = ensureSharedNodeModules({
  repoRoot,
  mainWorktreePath,
  services: [serviceName]
});

const child = spawn(command, {
  cwd: servicePath,
  env: {
    ...process.env,
    ...selectedEnv,
    PATH: `${servicePathBin}${path.delimiter}${rootBin}${path.delimiter}${process.env.PATH || ''}`
  },
  shell: true,
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
