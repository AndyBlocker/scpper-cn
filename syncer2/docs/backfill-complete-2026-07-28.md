# v1 → v2 回填完成记录（2026-07-28）

## 结论

2026-07-28 16:28:03 CST，`scpper-v2` 的 full strict
`checks/backfill_finalize.sql` 通过：**57 pass / 0 fail / 0 skip**，
`meta.backfill_gate_run.id=7`、`passed=true`。

本次完成不依赖冻结 v1。按用户决策 C4，`scpper-cn` 与 CROM 在整个修复和验收窗口
持续运行；本文数字是上述时刻的可复核快照，不代表 v1 此后停止增长。

## 最终身份快照

- v1 `Page`：47,880；v2 `ingest.page`：47,880；missing/conflict：0/0。
- v1 `User`：37,482；v2 `ingest.user`：37,894（含 412 个 S4 匿名 actor）；
  missing/conflict：0/0。
- final gate 前已重新执行 identity top-up，并重新载入 page/user/vote_anon/
  gacha_page_ref 四份身份集合；不是复用旧快照。
- `gacha_page_ref`：36,976；悬空引用 0。v1 投票匿名证据仍为 0。

## S4 匿名 actor 保留段修复

具名策略常量：

- v2 自铸 page 起点：`1,500,000,000`；
- S4 匿名 actor / v2 自铸 user 起点：`2,000,000,000`；
- v1 User 安全系数：`7`。

旧的 412 个 actor 位于 `283,252,969..283,253,380`。迁移 0204 在单一事务内：

1. 将 412 行完整旧值和逐外键引用计数写入不可变
   `meta.v1_anonymous_actor_remap_audit`；
2. clone 到 `2,000,000,000..2,000,000,411`；
3. 更新数据库中全部 19 个唯一 user 外键列；
4. 删除旧 actor，并动态枚举 `pg_constraint` 证明没有漏项；
5. 抬升 page/user 两条身份序列并提交。

实际非零引用为：

- `ingest.attribution_event.actor_id`：2,956；
- `serve.attribution_current.actor_id`：2,956；
- `meta.v1_attribution_map.actor_id`：3,429。

迁移后旧 user 行为 0。0204 已再次幂等执行，412 行审计和两张 freeze manifest
均未变化。

final gate A5.8 以最新 v1 快照重算：

```text
anon min = 2,000,000,000
v1 User.max(id) = 283,447,950
safety factor = 7
required exclusive floor = 1,984,135,650
```

因此 `anon min > v1 max × 7` 成立。该断言不是一次性记录：以后每次 full gate 都会
重新读取刚载入的 v1 identity；逼近边界时会在碰撞之前硬失败。

## 活库映射 top-up

S4 重跑时 v1 已新增 11 个 `PageVersion`。映射冻结语义已改为：

- 事务内删除旧 manifest；
- 逐行证明既有历史不变；
- 只允许上一条 current 的 `valid_to` 从 NULL 关闭，以及 display 空字段被补成非空；
- 追加新行，核对全量计数/fingerprint，再写回 manifest 并提交。

本次还观察到 5 个 `alternate_title` 的 NULL→非空补全；没有 page/id/validFrom/
versionNo/删除态或非空内容互改。最终：

- `meta.v1_attribution_map`：67,405，已冻结；
- `serve.attribution_current`：54,387；
- `meta.v1_version_map`：108,659，已冻结；
- S4/S5/S6 写后断言全部通过。

## 同类 id 分配扫描

代码扫描只发现一处正在执行的显式“当前上界 + 1”：原
`buildAttributionCarryoverPlan`，现已改为保留段水位分配，并同时考虑
`user_id_seq` 已交付但可能因事务回滚而未落表的 id。

另发现两条结构上等价的路径，均已处理：

- `register_page` 使用 `page_id_seq`：0204/finalize 固定保留段 floor
  `1,499,999,999`；
- `ensure_user`（含 guest/synthetic/anon/新 Wikidot actor）使用
  `user_id_seq`：固定保留段 floor `1,999,999,999`。

S1 top-up 始终显式写 v1 原 id，不消费保留段。`app.*` 的 13 条 identity 序列只服务
app 自有主键，不镜像任何 v1 id；finalize 动态发现、单调归位并逐条检查。仓库中
`0004_app.sql` 的 `max(id)+1` 只存在于明确标为“错误、不得照抄”的历史注释，不是
执行代码。

## RUNBOOK 与验证

`docs/RUNBOOK.md` 已把以下规则写成标准步骤：初次 S1 之后，进入 S2–S6、任何回填
修复事务以及 finalize 前，都先跑 identity top-up；需要跨库 gate 时紧接着重载
identity 证据。原因是 v1 活着、回填面对移动靶，不得以冻结 v1 作为解法。

最终本地验证：

- `npm run typecheck`；
- `npm run typecheck:tests`；
- `node --import tsx/esm --test tests/backfill-s456.test.ts`：10/10；
- `git diff --check`；
- full strict finalize：57/57。
