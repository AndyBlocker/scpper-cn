import { createRequire } from 'module';
import pg from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const PrismaClientModule = require('../../node_modules/.prisma/syncer-client');
const { PrismaClient: PrismaClientCtor } = PrismaClientModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

// ── Syncer DB (VoteSentinelCache / VoteChangeEvent) ──

let syncerPrisma: any = null;

export function getSyncerPrisma(): any {
  if (!syncerPrisma) {
    const url = process.env.SYNCER_DATABASE_URL;
    if (!url) throw new Error('SYNCER_DATABASE_URL is not set');
    syncerPrisma = new PrismaClientCtor({
      datasources: { db: { url } },
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
  }
  return syncerPrisma;
}

// ── Main DB (read-only, for PageVersion bootstrap) ──

let mainPool: pg.Pool | null = null;

export function getMainPool(): pg.Pool {
  if (!mainPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set (main DB for bootstrap reads)');
    // max used to be 3, which serialized every parallelizable write in
    // MainDbBridge (markPagesDeleted, createNewPageVersion, etc.). 10 lets
    // the bridge exploit concurrency within one run without dwarfing the
    // database's total max_connections (=500 in prod).
    const rawMax = Number(process.env.SYNCER_MAIN_POOL_MAX ?? '10');
    const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, 50) : 10;
    mainPool = new pg.Pool({ connectionString: url, max });
  }
  return mainPool;
}

// ── Cleanup ──

let signalsBound = false;

export function bindGracefulShutdown(): void {
  if (signalsBound) return;
  const cleanup = async (signal?: string) => {
    if (signal) console.log(`[db] Received ${signal}, disconnecting...`);
    try {
      if (syncerPrisma) await syncerPrisma.$disconnect();
      if (mainPool) await mainPool.end();
    } catch (err) {
      console.error('[db] Cleanup error:', err);
    } finally {
      syncerPrisma = null;
      mainPool = null;
      if (signal) process.exit(0);
    }
  };
  process.on('SIGINT', () => void cleanup('SIGINT'));
  process.on('SIGTERM', () => void cleanup('SIGTERM'));
  signalsBound = true;
}
