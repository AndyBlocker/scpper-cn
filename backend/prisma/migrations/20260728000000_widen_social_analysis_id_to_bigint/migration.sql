-- 修复 UserSocialAnalysisJob 的 int4 主键序列耗尽。
--
-- 【故障现象】2026-07-28 起 scpper-sync 每轮都报：
--   ERROR: nextval: reached maximum value of sequence "UserTagPreference_id_seq" (2147483647)
-- 导致 IncrementalAnalyzeJob 的 user_social_analysis 任务整段失败，用户标签偏好与
-- 用户投票交互两份聚合数据自此不再更新。
--
-- 【根因】两张表都用 `INSERT ... ON CONFLICT (natural_key) DO UPDATE` 做全量 upsert
-- （UserSocialAnalysisJob.ts 的 updateUserTagPreferences / updateUserVoteInteractions）。
-- PostgreSQL 对每一个候选行都会先求值 DEFAULT nextval()，**即使最终走的是冲突分支**，
-- 序列值照样被消耗且不回滚。于是每轮 sync 烧掉约 (51 万 + 82 万) 个序列值，
-- 24 轮/天 ≈ 3200 万/天，int4 的 21.47 亿号段约半年耗尽。
-- 实测：UserTagPreference_id_seq 已 100%（2147483647），UserVoteInteraction_id_seq 已 93.35%。
-- 两张表的实际行数分别只有 512339 / 816050 —— 号段消耗与行数完全脱钩，印证上述机制。
--
-- 【为什么两张表一起改】UserVoteInteraction 是同一个 Job、同一种写法、同一种 int4 序列，
-- 按当前速率数周内必然复现同一故障。只修一张等于给自己排了个定时炸弹。
--
-- 【为什么是加宽而不是重置序列】两张表的 `id` 都是 Prisma 补出来的 autoincrement 代理键，
-- 真正的身份是 @@unique([userId, tag]) / @@unique([fromUserId, toUserId])，
-- 且**没有任何外键引用它**（已核对 pg_constraint.confrelid），也没有任何 TS 代码读取该列
-- （两张表在 backend/bff/user-backend 中全部走裸 SQL，无 prisma.userTagPreference 模型调用）。
-- 重置序列到 1 会与存量高位 id 冲突；加宽到 int8 一劳永逸（按当前速率可用 ~78 万年）。
--
-- 【锁与耗时】ALTER COLUMN TYPE 会重写整表并重建索引，持有 ACCESS EXCLUSIVE 锁。
-- 两表含索引分别约 279 MB / 515 MB，预计合计数十秒。**执行前应先停 scpper-sync**，
-- 否则会与正在跑的 upsert 互相阻塞。
--
-- 【顺序要求】必须先加宽列、后加宽序列。反过来的话，序列可能先发出 > 2^31 的值，
-- 而列仍是 int4，INSERT 会立刻失败。
--
-- 【空库重放】用 to_regclass 守卫，保证 shadow database / 新环境 / CI 上可重放。

DO $$
BEGIN
  ----------------------------------------------------------------------------
  -- UserTagPreference：序列已 100% 耗尽（本次故障的直接原因）
  ----------------------------------------------------------------------------
  IF to_regclass('public."UserTagPreference"') IS NOT NULL THEN
    ALTER TABLE "UserTagPreference" ALTER COLUMN "id" TYPE BIGINT;
  END IF;

  IF to_regclass('public."UserTagPreference_id_seq"') IS NOT NULL THEN
    ALTER SEQUENCE "UserTagPreference_id_seq"
      AS BIGINT
      MAXVALUE 9223372036854775807;
  END IF;

  ----------------------------------------------------------------------------
  -- UserVoteInteraction：序列已 93.35%，预防性同步加宽
  ----------------------------------------------------------------------------
  IF to_regclass('public."UserVoteInteraction"') IS NOT NULL THEN
    ALTER TABLE "UserVoteInteraction" ALTER COLUMN "id" TYPE BIGINT;
  END IF;

  IF to_regclass('public."UserVoteInteraction_id_seq"') IS NOT NULL THEN
    ALTER SEQUENCE "UserVoteInteraction_id_seq"
      AS BIGINT
      MAXVALUE 9223372036854775807;
  END IF;
END $$;
