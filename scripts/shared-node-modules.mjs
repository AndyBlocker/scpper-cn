import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRootFromScript = path.resolve(scriptsDir, '..');

function resolveGitMetadata(repoRoot = repoRootFromScript) {
  const dotGitPath = path.join(repoRoot, '.git');
  const stat = fs.lstatSync(dotGitPath);

  if (stat.isDirectory()) {
    return {
      gitDir: dotGitPath,
      mainWorktreePath: repoRoot
    };
  }

  const content = fs.readFileSync(dotGitPath, 'utf8').trim();
  const match = content.match(/^gitdir:\s*(.+)$/);

  if (!match) {
    throw new Error(`Unsupported .git file format at ${dotGitPath}`);
  }

  const gitDir = path.resolve(repoRoot, match[1]);

  return {
    gitDir,
    mainWorktreePath: path.resolve(gitDir, '../../..')
  };
}

export function getRepoRoot() {
  return repoRootFromScript;
}

export function findMainWorktree(repoRoot = repoRootFromScript) {
  return resolveGitMetadata(repoRoot).mainWorktreePath;
}

export function getBranchName(repoRoot = repoRootFromScript) {
  const { gitDir } = resolveGitMetadata(repoRoot);
  const headContent = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  const match = headContent.match(/^ref:\s+refs\/heads\/(.+)$/);
  return match?.[1] ?? '';
}

function nodeModulesPath(rootPath, serviceName) {
  if (!serviceName) {
    return path.join(rootPath, 'node_modules');
  }
  return path.join(rootPath, serviceName, 'node_modules');
}

function isMatchingSymlink(targetPath, sourcePath) {
  try {
    const stat = fs.lstatSync(targetPath);
    return stat.isSymbolicLink() && fs.readlinkSync(targetPath) === sourcePath;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EPERM');
  }
}

function sleepMs(durationMs) {
  const sharedBuffer = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sharedBuffer);
  Atomics.wait(int32, 0, 0, durationMs);
}

function withServiceMutex(lockDirPath, callback) {
  const mutexDirPath = path.join(lockDirPath, '.mutex');
  const ownerFilePath = path.join(mutexDirPath, 'owner.pid');
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(mutexDirPath, { recursive: false });
      fs.writeFileSync(ownerFilePath, `${process.pid}\n`);
      break;
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) {
        throw err;
      }

      let staleOwner = true;
      try {
        const ownerPid = Number.parseInt(fs.readFileSync(ownerFilePath, 'utf8').trim(), 10);
        staleOwner = !isProcessAlive(ownerPid);
      } catch {
        staleOwner = true;
      }

      if (staleOwner) {
        fs.rmSync(mutexDirPath, { force: true, recursive: true });
        continue;
      }

      if (Date.now() - startedAt > 5000) {
        throw new Error(`Timed out waiting for shared node_modules mutex: ${mutexDirPath}`);
      }

      sleepMs(25);
    }
  }

  try {
    return callback();
  } finally {
    try {
      fs.rmSync(ownerFilePath, { force: true });
      fs.rmdirSync(mutexDirPath);
    } catch {
      // Best effort mutex cleanup.
    }
  }
}

function pruneStaleLocks(lockDirPath) {
  if (!fs.existsSync(lockDirPath)) {
    return [];
  }

  const remainingLocks = [];

  for (const fileName of fs.readdirSync(lockDirPath)) {
    if (!fileName.endsWith('.lock')) {
      continue;
    }

    const pid = Number.parseInt(fileName.split('-', 1)[0] || '', 10);
    const lockFilePath = path.join(lockDirPath, fileName);

    if (isProcessAlive(pid)) {
      remainingLocks.push(lockFilePath);
      continue;
    }

    fs.rmSync(lockFilePath, { force: true });
  }

  return remainingLocks;
}

export function ensureSharedNodeModules({
  repoRoot,
  mainWorktreePath,
  services = []
}) {
  if (!repoRoot || !mainWorktreePath || repoRoot === mainWorktreePath) {
    return {
      cleanup() {}
    };
  }

  const created = [];
  const uniqueServices = Array.from(new Set(['', ...services.filter(Boolean)]));
  const { gitDir } = resolveGitMetadata(repoRoot);
  const locksRoot = path.join(gitDir, 'shared-node-modules');

  for (const serviceName of uniqueServices) {
    const targetPath = nodeModulesPath(repoRoot, serviceName);
    const sourcePath = nodeModulesPath(mainWorktreePath, serviceName);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const serviceKey = serviceName || '__root__';
    const lockDirPath = path.join(locksRoot, serviceKey);
    const markerPath = path.join(lockDirPath, '.managed');
    fs.mkdirSync(lockDirPath, { recursive: true });
    let createdRecord = null;

    withServiceMutex(lockDirPath, () => {
      const targetExists = fs.existsSync(targetPath);
      const matchingSymlink = isMatchingSymlink(targetPath, sourcePath);

      if (targetExists && !matchingSymlink) {
        return;
      }

      let managedByTool = fs.existsSync(markerPath);

      if (!targetExists) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        try {
          fs.symlinkSync(sourcePath, targetPath, 'dir');
        } catch (err) {
          if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) {
            throw err;
          }
          if (!isMatchingSymlink(targetPath, sourcePath)) {
            return;
          }
        }
        fs.writeFileSync(markerPath, `${sourcePath}\n`);
        managedByTool = true;
      } else if (!managedByTool) {
        return;
      }

      const lockFilePath = path.join(
        lockDirPath,
        `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`
      );
      fs.writeFileSync(lockFilePath, `${sourcePath}\n`);
      createdRecord = { lockDirPath, lockFilePath, markerPath, sourcePath, targetPath };
    });

    if (createdRecord) {
      created.push(createdRecord);
    }
  }

  return {
    cleanup() {
      for (const { lockDirPath, lockFilePath, markerPath, sourcePath, targetPath } of created.reverse()) {
        try {
          withServiceMutex(lockDirPath, () => {
            fs.rmSync(lockFilePath, { force: true });
            const remainingLocks = pruneStaleLocks(lockDirPath);
            if (remainingLocks.length > 0) {
              return;
            }
            if (!fs.existsSync(markerPath)) {
              return;
            }
            if (!isMatchingSymlink(targetPath, sourcePath)) {
              return;
            }
            fs.rmSync(targetPath, { force: true, recursive: true });
            fs.rmSync(markerPath, { force: true });
            fs.rmdirSync(lockDirPath);
          });
        } catch {
          // Best effort cleanup for temporary worktree links.
        }
      }
    }
  };
}
