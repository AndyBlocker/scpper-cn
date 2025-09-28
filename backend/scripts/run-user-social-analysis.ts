#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';
import { updateUserSocialAnalysis } from '../src/jobs/UserSocialAnalysisJob.js';

function getFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const prisma = getPrismaClient();
  const full = getFlag('full') || getFlag('forceFull') || getFlag('all');
  const batchSize = (() => {
    const idx = process.argv.findIndex(a => a === '--batch');
    if (idx >= 0 && idx + 1 < process.argv.length) return Number(process.argv[idx + 1]) || 1000;
    return 1000;
  })();
  try {
    console.log(`Running UserSocialAnalysisJob with forceFullAnalysis=${full} batchSize=${batchSize} ...`);
    await updateUserSocialAnalysis(prisma, { forceFullAnalysis: full, batchSize });
    console.log('Done.');
  } catch (err) {
    console.error('Error running UserSocialAnalysisJob:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();



