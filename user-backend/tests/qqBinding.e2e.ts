/**
 * QQ 绑定的端到端验证（对影子库跑真实事务，不碰生产）。
 * 用法：USER_DATABASE_URL=<shadow> node --import tsx e2e-qq.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  startQqBinding,
  verifyQqBinding,
  getQqBindingStatus,
  cancelQqBinding,
  unbindQq
} from '../src/services/qqBinding.js';

// ─── 安全护栏 ────────────────────────────────────────────────────────────
// 本测试会 deleteMany 掉整个账号表，绝不能连到生产库。
// 只允许库名里带 shadow / test / e2e 的目标，否则直接退出。
const DB_URL = process.env.USER_DATABASE_URL || '';
const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? '';
if (!/(shadow|test|e2e)/i.test(dbName)) {
  console.error(
    `拒绝运行：目标库 "${dbName}" 看起来不是影子库。\n` +
    '本测试会清空 UserAccount / NotificationChannelBinding / ChannelBindingChallenge，\n' +
    '请把 USER_DATABASE_URL 指向库名含 shadow/test/e2e 的一次性数据库。'
  );
  process.exit(2);
}

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label} ${extra}`); }
}

async function main() {
  await prisma.channelBindingChallenge.deleteMany({});
  await prisma.notificationChannelBinding.deleteMany({});
  await prisma.userAccount.deleteMany({});
  const alice = await prisma.userAccount.create({
    data: { email: 'alice@test.local', status: 'ACTIVE', passwordHash: 'x' }
  });
  const bob = await prisma.userAccount.create({
    data: { email: 'bob@test.local', status: 'ACTIVE', passwordHash: 'x' }
  });

  console.log('\n[1] 发起绑定');
  const started = await startQqBinding(alice.id, '1248393597');
  check('返回明文验证码', /^SCPPER-[A-Z2-9]{12}$/.test(started.code), started.code);
  check('TTL 在 10–30 分钟内', started.ttlMinutes >= 10 && started.ttlMinutes <= 30);
  const stored = await prisma.channelBindingChallenge.findFirst({ where: { userId: alice.id } });
  check('库里没有明文码', !JSON.stringify(stored).includes(started.code.slice(7)));
  check('库里存的是 64 位哈希', (stored?.codeHash ?? '').length === 64);
  check('提示只有末 4 位', stored?.codeHint === started.code.slice(-4));

  console.log('\n[2] 状态查询不回显明文');
  const st = await getQqBindingStatus(alice.id);
  check('未绑定时 binding 为 null', st.binding === null);
  check('有进行中的挑战', st.challenge !== null);
  check('状态里不含明文码', !JSON.stringify(st).includes(started.code.slice(7)));

  console.log('\n[3] 重复发起会作废旧码');
  const second = await startQqBinding(alice.id, '1248393597');
  check('新码与旧码不同', second.code !== started.code);
  const oldOne = await prisma.channelBindingChallenge.findUnique({ where: { codeHash: stored!.codeHash } });
  check('旧挑战被置为 CANCELLED', oldOne?.status === 'CANCELLED');
  const r0 = await verifyQqBinding({ qq: '1248393597', code: started.code });
  check('旧码不再可用', !r0.matched, JSON.stringify(r0));

  console.log('\n[4] 错误输入');
  check('乱码被拒', !(await verifyQqBinding({ qq: '123456', code: 'not-a-code' })).matched);
  check('不存在的码被拒', !(await verifyQqBinding({ qq: '123456', code: 'SCPPER-ZZZZZZZZ9999' })).matched);
  check('非法 QQ 被拒', !(await verifyQqBinding({ qq: '0012', code: second.code })).matched);
  const r1 = await verifyQqBinding({ qq: '123456', code: 'SCPPER-ZZZZZZZZ9999' });
  const r2 = await verifyQqBinding({ qq: '123456', code: 'not-a-code' });
  check('「码不存在」与「格式错」文案相同（防枚举）', r1.reply === r2.reply);

  console.log('\n[5] 正常核销');
  const ok = await verifyQqBinding({ qq: '1000000001', code: second.code, source: 'friend_request' });
  check('核销成功', ok.matched, JSON.stringify(ok));
  const st2 = await getQqBindingStatus(alice.id);
  check('绑定已建立', st2.binding !== null);
  check('只返回掩码', st2.binding?.addressMask === '1000***1', st2.binding?.addressMask);
  check('掩码不含完整号', !JSON.stringify(st2).includes('1000000001'));

  console.log('\n[6] 幂等与重放');
  const replay = await verifyQqBinding({ qq: '1000000001', code: second.code });
  check('同一个码不能再用（防重放）', !replay.matched, JSON.stringify(replay));
  check('重放提示与通用提示不同', replay.reply !== r1.reply);

  console.log('\n[7] 唯一性');
  const bobStart = await startQqBinding(bob.id, '1248393597');
  const taken = await verifyQqBinding({ qq: '1000000001', code: bobStart.code });
  check('同一 QQ 不能绑第二个账号', !taken.matched, JSON.stringify(taken));
  check('给出可区分的换绑提示', /已经绑定到另一个站点账号/.test(taken.reply));
  let threw = false;
  try { await startQqBinding(alice.id, null); } catch (e) { threw = /已绑定/.test((e as Error).message); }
  check('已绑账号再次发起被拒', threw);

  console.log('\n[8] 取消');
  await cancelQqBinding(bob.id);
  const bobAfter = await verifyQqBinding({ qq: '1000000002', code: bobStart.code });
  check('取消后原码失效', !bobAfter.matched);

  console.log('\n[9] 解绑需要密码');
  let wrongPw = false;
  try { await unbindQq(alice.id, async () => false); } catch (e) { wrongPw = /密码不正确/.test((e as Error).message); }
  check('密码错误时拒绝解绑', wrongPw);
  const stillBound = await getQqBindingStatus(alice.id);
  check('拒绝后绑定仍在', stillBound.binding !== null);
  await unbindQq(alice.id, async () => true);
  const afterUnbind = await getQqBindingStatus(alice.id);
  check('密码正确后解绑成功', afterUnbind.binding === null);

  console.log('\n[10] 解绑后可重新绑定（REVOKED 行不挡唯一键）');
  const re = await startQqBinding(alice.id, null);
  const reOk = await verifyQqBinding({ qq: '1000000001', code: re.code });
  check('可用同一 QQ 重新绑定', reOk.matched, JSON.stringify(reOk));
  const rows = await prisma.notificationChannelBinding.count({ where: { userId: alice.id } });
  check('复用同一行而非新增（唯一键要求）', rows === 1, `rows=${rows}`);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
