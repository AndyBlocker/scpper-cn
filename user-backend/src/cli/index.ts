#!/usr/bin/env node
import { linkWikidotUser, unlinkWikidotUser } from './linkWikidot.js';
import { adminResetPassword } from './resetPassword.js';
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
