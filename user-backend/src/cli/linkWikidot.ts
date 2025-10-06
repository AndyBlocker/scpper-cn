import { prisma } from '../db.js';

interface LinkArgs {
  email: string;
  wikidotId: number;
  force?: boolean;
  takeover?: boolean;
}

interface LinkResult {
  updatedAccount: {
    id: string;
    email: string;
    linkedWikidotId: number | null;
  };
  clearedAccountEmail?: string;
  previousLinkedWikidotId?: number | null;
}

interface UnlinkArgs {
  email?: string;
  wikidotId?: number;
}

interface UnlinkResult {
  email: string;
  previousLinkedWikidotId: number;
}

export async function linkWikidotUser(args: LinkArgs): Promise<LinkResult> {
  const email = args.email.trim().toLowerCase();
  const wikidotId = args.wikidotId;
  const force = Boolean(args.force);
  const takeover = Boolean(args.takeover);

  const account = await prisma.userAccount.findUnique({ where: { email } });
  if (!account) {
    throw new Error(`未找到邮箱为 ${email} 的用户账号`);
  }

  if (account.linkedWikidotId === wikidotId) {
    return {
      updatedAccount: {
        id: account.id,
        email: account.email,
        linkedWikidotId: account.linkedWikidotId ?? null
      },
      previousLinkedWikidotId: account.linkedWikidotId ?? null
    };
  }

  if (account.linkedWikidotId && account.linkedWikidotId !== wikidotId && !force) {
    throw new Error(`该账号已绑定 wikidotId=${account.linkedWikidotId}，如需覆盖请添加 --force`);
  }

  const existing = await prisma.userAccount.findUnique({ where: { linkedWikidotId: wikidotId } });
  let clearedAccountEmail: string | undefined;
  if (existing && existing.id !== account.id) {
    if (!takeover) {
      throw new Error(`wikidotId=${wikidotId} 已绑定到账号 ${existing.email}，如需转移请添加 --takeover`);
    }
    await prisma.userAccount.update({
      where: { id: existing.id },
      data: { linkedWikidotId: null }
    });
    clearedAccountEmail = existing.email;
  }

  const updated = await prisma.userAccount.update({
    where: { id: account.id },
    data: { linkedWikidotId: wikidotId }
  });

  return {
    updatedAccount: {
      id: updated.id,
      email: updated.email,
      linkedWikidotId: updated.linkedWikidotId ?? null
    },
    clearedAccountEmail,
    previousLinkedWikidotId: account.linkedWikidotId ?? null
  };
}

export async function unlinkWikidotUser(args: UnlinkArgs): Promise<UnlinkResult> {
  if ((args.email && args.wikidotId) || (!args.email && !args.wikidotId)) {
    throw new Error('请提供 --email 或 --wikidotId（且只能提供一个）');
  }

  if (args.email) {
    const email = args.email.trim().toLowerCase();
    const account = await prisma.userAccount.findUnique({ where: { email } });
    if (!account) {
      throw new Error(`未找到邮箱为 ${email} 的用户账号`);
    }
    if (!account.linkedWikidotId) {
      throw new Error(`账号 ${account.email} 未绑定 wikidotId，无法解绑`);
    }
    const updated = await prisma.userAccount.update({
      where: { id: account.id },
      data: { linkedWikidotId: null }
    });
    return {
      email: updated.email,
      previousLinkedWikidotId: account.linkedWikidotId
    };
  }

  const wikidotId = args.wikidotId as number;
  if (!Number.isInteger(wikidotId) || wikidotId <= 0) {
    throw new Error('wikidotId 必须是正整数');
  }
  const accountWithId = await prisma.userAccount.findUnique({ where: { linkedWikidotId: wikidotId } });
  if (!accountWithId) {
    throw new Error(`wikidotId=${wikidotId} 未绑定任何账号`);
  }
  await prisma.userAccount.update({
    where: { id: accountWithId.id },
    data: { linkedWikidotId: null }
  });
  return {
    email: accountWithId.email,
    previousLinkedWikidotId: wikidotId
  };
}
