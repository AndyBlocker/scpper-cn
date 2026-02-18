#!/usr/bin/env node
import { linkWikidotUser, unlinkWikidotUser } from './linkWikidot.js';
import { adminResetPassword } from './resetPassword.js';
import { resetGachaUserData } from './gachaResetData.js';
import { backfillGachaLegacyAffix } from './gachaBackfillLegacyAffix.js';
import { backfillGachaPityCounters } from './gachaBackfillPity.js';
import { backfillGachaInstances } from './gachaBackfillInstances.js';
import { consolidateVariants } from './gachaConsolidateVariants.js';
import { prisma } from '../db.js';

interface ParsedArgs {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        result[key] = true;
        i += 1;
      } else {
        result[key] = next;
        i += 2;
      }
    } else {
      result._.push(token);
      i += 1;
    }
  }
  return result;
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(`可用命令：
  link-wikidot --email <email> --wikidotId <id> [--force] [--takeover]
  unlink-wikidot --email <email> | --wikidotId <id>
  reset-password --email <email> --password <newPassword>
  gacha-reset-data [--userId <id> | --email <email>] [--dry-run] [--force]
  gacha-backfill-legacy-affix [--userId <id> | --email <email>] [--dry-run] [--batch-size <n>]
  gacha-backfill-pity [--userId <id> | --email <email>] [--dry-run]
  gacha-backfill-instances [--userId <id> | --email <email>] [--dry-run] [--batch-size <n>]
  consolidate-variants [--dry-run]
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage();
    return;
  }
  const command = argv[0];
  const rest = parseArgs(argv.slice(1));

  try {
    switch (command) {
      case 'link-wikidot': {
        const emailArg = rest.email;
        const wikidotIdArg = rest.wikidotId;
        if (typeof emailArg !== 'string' || typeof wikidotIdArg !== 'string') {
          throw new Error('请同时提供 --email 和 --wikidotId');
        }
        const wikidotId = Number(wikidotIdArg);
        if (!Number.isInteger(wikidotId) || wikidotId <= 0) {
          throw new Error('wikidotId 必须是正整数');
        }
        const force = rest.force === true;
        const takeover = rest.takeover === true;
        const result = await linkWikidotUser({ email: emailArg, wikidotId, force, takeover });
        // eslint-disable-next-line no-console
        console.log(`账号 ${result.updatedAccount.email} 已绑定 wikidotId=${result.updatedAccount.linkedWikidotId}`);
        if (result.previousLinkedWikidotId && result.previousLinkedWikidotId !== wikidotId) {
          // eslint-disable-next-line no-console
          console.log(`原先绑定的 wikidotId=${result.previousLinkedWikidotId} 已被覆盖`);
        }
        if (result.clearedAccountEmail) {
          // eslint-disable-next-line no-console
          console.log(`已为账号 ${result.clearedAccountEmail} 解除旧绑定`);
        }
        break;
      }
      case 'unlink-wikidot': {
        const emailArg = rest.email;
        const wikidotIdArg = rest.wikidotId;
        if ((typeof emailArg === 'string' && typeof wikidotIdArg === 'string') ||
            (typeof emailArg !== 'string' && typeof wikidotIdArg !== 'string')) {
          throw new Error('请提供 --email 或 --wikidotId（且只能提供一个）');
        }
        if (typeof wikidotIdArg === 'string' && typeof emailArg !== 'string') {
          const wikidotId = Number(wikidotIdArg);
          if (!Number.isInteger(wikidotId) || wikidotId <= 0) {
            throw new Error('wikidotId 必须是正整数');
          }
          const result = await unlinkWikidotUser({ wikidotId });
          // eslint-disable-next-line no-console
          console.log(`账号 ${result.email} 已解除 wikidotId=${result.previousLinkedWikidotId}`);
        } else if (typeof emailArg === 'string') {
          const result = await unlinkWikidotUser({ email: emailArg });
          // eslint-disable-next-line no-console
          console.log(`账号 ${result.email} 已解除 wikidotId=${result.previousLinkedWikidotId}`);
        }
        break;
      }
      case 'reset-password': {
        const emailArg = rest.email;
        const passwordArg = rest.password;
        if (typeof emailArg !== 'string' || typeof passwordArg !== 'string') {
          throw new Error('请同时提供 --email 和 --password');
        }
        const result = await adminResetPassword({ email: emailArg, password: passwordArg });
        // eslint-disable-next-line no-console
        console.log(`已为账号 ${result.email} 重置密码`);
        break;
      }
      case 'gacha-reset-data': {
        const dryRun = rest['dry-run'] === true || rest.dryRun === true;
        const force = rest.force === true;

        let userId = typeof rest.userId === 'string' ? rest.userId : undefined;
        const email = typeof rest.email === 'string' ? rest.email.trim().toLowerCase() : undefined;
        if (!userId && email) {
          const user = await prisma.userAccount.findUnique({ where: { email } });
          if (!user) {
            throw new Error('未找到目标用户');
          }
          userId = user.id;
        }

        if (!userId && !force) {
          throw new Error('全量重置需要显式传入 --force（仅会清理 gacha 域表）');
        }

        const summary = await resetGachaUserData({
          userId,
          dryRun
        });
        // eslint-disable-next-line no-console
        console.log(
          `[gacha-reset-data] dryRun=${summary.dryRun} scope=${summary.scope}${summary.userId ? ` userId=${summary.userId}` : ''}\ncountsBefore=${JSON.stringify(summary.countsBefore)}\ndeleted=${JSON.stringify(summary.deleted)}`
        );
        break;
      }
      case 'gacha-backfill-legacy-affix': {
        const dryRun = rest['dry-run'] === true || rest.dryRun === true;
        const batchSizeRaw = typeof rest['batch-size'] === 'string'
          ? Number(rest['batch-size'])
          : (typeof rest.batchSize === 'string' ? Number(rest.batchSize) : undefined);

        let userId = typeof rest.userId === 'string' ? rest.userId : undefined;
        const email = typeof rest.email === 'string' ? rest.email.trim().toLowerCase() : undefined;
        if (!userId && email) {
          const user = await prisma.userAccount.findUnique({ where: { email } });
          if (!user) {
            throw new Error('未找到目标用户');
          }
          userId = user.id;
        }

        const summary = await backfillGachaLegacyAffix({
          userId,
          dryRun,
          batchSize: Number.isFinite(batchSizeRaw as number) ? Number(batchSizeRaw) : undefined
        });
        // eslint-disable-next-line no-console
        console.log(
          `[gacha-backfill-legacy-affix] dryRun=${summary.dryRun} scope=${summary.scope}${summary.userId ? ` userId=${summary.userId}` : ''}\nsummary=${JSON.stringify(summary)}`
        );
        break;
      }
      case 'gacha-backfill-pity': {
        const dryRun = rest['dry-run'] === true || rest.dryRun === true;

        let userId = typeof rest.userId === 'string' ? rest.userId : undefined;
        const email = typeof rest.email === 'string' ? rest.email.trim().toLowerCase() : undefined;
        if (!userId && email) {
          const user = await prisma.userAccount.findUnique({ where: { email } });
          if (!user) {
            throw new Error('未找到目标用户');
          }
          userId = user.id;
        }

        const summary = await backfillGachaPityCounters({ userId, dryRun });
        // eslint-disable-next-line no-console
        console.log(
          `[gacha-backfill-pity] dryRun=${summary.dryRun} scope=${summary.scope}` +
          `${summary.userId ? ` userId=${summary.userId}` : ''}` +
          `\nusers processed: ${summary.usersProcessed}, updated: ${summary.usersUpdated}` +
          `, items scanned: ${summary.totalItemsScanned}`
        );
        for (const d of summary.details) {
          if (d.changed) {
            // eslint-disable-next-line no-console
            console.log(
              `  ${d.changed ? '✓' : '-'} ${d.displayName}: ${d.itemCount} items → purple=${d.purplePityCount} gold=${d.goldPityCount}`
            );
          }
        }
        break;
      }
      case 'gacha-backfill-instances': {
        const dryRun = rest['dry-run'] === true || rest.dryRun === true;
        const batchSizeRaw = typeof rest['batch-size'] === 'string'
          ? Number(rest['batch-size'])
          : (typeof rest.batchSize === 'string' ? Number(rest.batchSize) : undefined);

        let userId = typeof rest.userId === 'string' ? rest.userId : undefined;
        const email = typeof rest.email === 'string' ? rest.email.trim().toLowerCase() : undefined;
        if (!userId && email) {
          const user = await prisma.userAccount.findUnique({ where: { email } });
          if (!user) {
            throw new Error('未找到目标用户');
          }
          userId = user.id;
        }

        const summary = await backfillGachaInstances({
          userId,
          dryRun,
          batchSize: Number.isFinite(batchSizeRaw as number) ? Number(batchSizeRaw) : undefined
        });
        // eslint-disable-next-line no-console
        console.log(
          `[gacha-backfill-instances] dryRun=${summary.dryRun} scope=${summary.scope}${summary.userId ? ` userId=${summary.userId}` : ''}` +
          `\ninventory scanned: ${summary.inventoryScanned}, instances created: ${summary.instancesCreated}` +
          `\ntrade listings: ${summary.tradeListingsProcessed}, trade instances: ${summary.tradeInstancesCreated}` +
          `\nplacement slots: ${summary.placementSlotsScanned}, linked: ${summary.placementSlotsLinked}, unmatched: ${summary.placementSlotsUnmatched}`
        );
        break;
      }
      case 'consolidate-variants': {
        const dryRun = rest['dry-run'] === true || rest.dryRun === true;
        const result = await consolidateVariants({ dryRun });
        // eslint-disable-next-line no-console
        console.log(
          `[consolidate-variants] dryRun=${result.dryRun}` +
          `\npages scanned: ${result.pagesScanned}, derived cards: ${result.derivedCardsFound}` +
          `\ninstances repointed: ${result.instancesRepointed}` +
          `\ninventories merged: ${result.inventoriesMerged}, deleted: ${result.inventoriesDeleted}` +
          `\nunlocks ensured: ${result.unlocksEnsured}` +
          `\ntrade listings: ${result.tradeListingsRepointed}, buy requests: ${result.buyRequestsRepointed}` +
          `\noffered cards: ${result.buyRequestOfferedCardsRepointed}` +
          `\nplacement slots: ${result.placementSlotsRepointed}, draw items: ${result.drawItemsRepointed}` +
          `\ncard definitions deleted: ${result.cardDefinitionsDeleted}`
        );
        break;
      }
      default:
        printUsage();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
