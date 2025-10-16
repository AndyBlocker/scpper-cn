import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

export async function adminResetPassword(params: { email: string; password: string }) {
  const email = params.email.trim().toLowerCase();
  if (!email) throw new Error('请提供有效邮箱');
  if (!params.password || params.password.length < 8) throw new Error('密码至少 8 位');

  const account = await prisma.userAccount.findUnique({ where: { email } });
  if (!account) throw new Error(`未找到邮箱为 ${email} 的用户账号`);

  const passwordHash = await bcrypt.hash(params.password, 12);
  await prisma.userAccount.update({ where: { id: account.id }, data: { passwordHash } });

  return { email: account.email } as const;
}

