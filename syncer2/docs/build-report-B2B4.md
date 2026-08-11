# B2/B4 撕裂读与分链路中间态口径修复

日期：2026-08-11  
工作树：`feat__syncer2-foundation`（`scpper-backend-v2`）

## 结论

B2/B4 不变量没有放宽，也没有把不一致吞成成功。`serve.user_stats` 刷新事务现在按固定
顺序同时持有 `serve.user_attr_daily` 和 `serve.user_stats` 两把既有 projector advisory
lock；从刷新开始到全局/窗口两次断言结束，另一轮 projector 不能提交任一相关投影。
断言仍用原 SQL、原稳定样本和原抛错出口，稳定态真实差异仍是 `failed`。

分链路监控不改 `meta.page_scan` 热表。现有采集器已经用
`l0_claim_only:`、`l1_claim_only:`、`tier1_claim_only:`、`listpages_claim_only:` 标记
“只登记声明、等待完整抓取”的 `partial` 证据；0054 只在视图层把这些行分类为
`intermediate`。它们既不计成功，也不计失败，且单独暴露数量。

## 1. B2/B4 的实际竞态边界

断言查询本身是一条 SQL。PostgreSQL 在 `READ COMMITTED` 下已保证单条语句使用同一语句
快照，所以问题不是 JOIN/CTE 内先读曲线、后读统计。真正的两个求值时点是：

1. `projectUserStats()` 用一条 SQL 全量写出新的 `serve.user_stats`；
2. 随后另一条 SQL 读取 `serve.user_attr_daily` 与本事务刚写出的 `user_stats` 做断言。

旧实现只持有 `serve.user_stats` 的事务锁。另一轮 `serve.user_attr_daily` projector 可以在
上述两条语句之间提交，于是第二条语句合法地看到了“本轮统计 + 另一轮曲线”。固定
`targetSeq` 只能约束事实消费水位，不能约束这次当前表提交，因此不能关闭这个窗口。

## 2. 选择成对事务锁，而不是版本放宽

`projectionTransactionLocks('serve.user_stats')` 固定返回：

```text
serve.user_attr_daily
serve.user_stats
```

runner 在读取游标和写投影前依次拿锁；`projectUserStats()` apply 入口也防御性地拿同一组
锁，覆盖测试、回填和未来直接调用。事务级 advisory lock 可重入，事务提交/回滚自动释放；
依赖表永远在前，两个 user_stats writer 不会因反序拿锁形成死锁。普通 projector 仍只拿
自己的锁，锁范围没有扩散到无关投影。

没有选择以下方案：

- 只按 `targetSeq` 比对：当前表没有行级投影版本，且水位不能阻止并发提交；
- 遇到差异一律 `inconclusive`：会把稳定态真差异一起隐藏，削弱不变量；
- 只提高事务隔离级别：若事务快照恰好固定在另一轮两张投影的提交间隙，会把逻辑中间态
  保存到整个事务；成对写锁会先等待相关 writer 完成，并在本次刷新/断言期间禁止新提交。

因此本实现采用“同一事务持有两张表的写者锁 + 断言单语句快照”。它不需要 schema 或
历史版本列，也不产生 `inconclusive`；竞争者只是等待本次短事务结束。

## 3. 真实不一致仍然失败

两条原断言未改：

- 全局稳定哈希抽样最多 64 位有已删作品作者；
- 本轮删除窗口再定向抽样最多 64 位，防止新删除被全局样本暂时漏掉。

任一受检作者满足 `latest(cum_rating) <> user_stats.total_rating` 时仍抛
`B2/B4 ... 自洽性失败`。新增回归为窗口内作者写入 `total_rating = cum_rating + 1`，断言
确认抛错；没有容差、重试后忽略、跳过样本或将 mismatch 改成 inconclusive。

## 4. page_scan 中间态口径

迁移 `0054_page_scan_intermediate_health.sql` 重建两个视图，不 ALTER、不回填、不重写
每小时约 3.6 万行的 `meta.page_scan`：

| 字段 | 含义 |
| --- | --- |
| `scan_count` | 最近一小时原始 page_scan 证据总数 |
| `intermediate_count` | `status=partial` 且 error 为受控 `*_claim_only:` 前缀 |
| `evaluated_count` | `scan_count - intermediate_count`，成功率和 critical 的分母 |
| `success_count` | 可判定行中 `status=ok` 的数量 |
| `partial_count` / `failed_count` | 可判定行中的真实 partial / failed |

判定改为：

```text
scan_count = 0
  => ok / no_tasks
evaluated_count = 0 且 scan_count > 0
  => ok / intermediate_only / success_rate=NULL
evaluated_count >= 10 且 success_count = 0
  => critical / rolling_zero_success
其它
  => ok / has_success_or_below_sample_threshold
```

这不是把 claim_only 算作 ok：成功数仍为 0，成功率为 NULL，表示本窗口没有可判定样本。
普通 `partial` 与 `failed` 没有相应受控前缀，仍进入失败分母并可触发 critical。
`meta.pending_collection_current` 的告警证据同时记录 raw scans、intermediates、evaluated、
successes、partial、failed，运维可直接复核分账。

## 5. 迁移顺序与成本

0054 已在任何 TypeScript/检查脚本引用 `intermediate_count`、`evaluated_count` 之前先应用到
`scpper-v2`。迁移只做 `CREATE OR REPLACE VIEW` 和 COMMENT：

- 没有修改 `page_scan.status` CHECK；
- 没有 `ALTER TABLE`、默认值回填或表重写；
- 没有新增高频写索引；
- 最近一小时过滤继续使用既有 `ps_scanned_at` 索引。

迁移自带目标库黑名单与 0053 前置对象检查，并可幂等重跑。

## 6. 回归覆盖

- 双连接构造并发 projector：断言事务先持有两张生产同名 advisory lock，另一连接按
  “曲线事务 → 统计事务”发布时必须等待；断言看到稳定对，不误报；释放后两表正常发布；
- 构造稳定态真差异：`cum_rating=1352 / total_rating=1353` 可见；真实 B2/B4 窗口断言
  另以 fixture 确认抛错；
- revisions 100 行全为 `l1_claim_only`：`intermediate_count=100`、`evaluated_count=0`、
  `decision=intermediate_only`，不进入 pending critical；
- files 100 行全为真实 `failed`：`evaluated_count=100`、`success_count=0`，仍为 critical；
- 0 行 kind：仍为 `no_tasks`。

## 7. 最终验证

- `0054_page_scan_intermediate_health.sql` 在 `scpper-v2` 首次应用成功，幂等复跑成功；
- `checks/0003_oldest_pending.sql` 通过。活库 revisions 当时为 2 scans / 2 intermediate /
  0 evaluated，显示 `intermediate_only`，没有 page_scan critical；
- `npx tsc --noEmit`：通过；
- `npm test`：462/462 通过，0 fail / 0 skipped；
- `git diff --check`：通过。

首次 projector 定向回归曾在活库未追平窗口命中 37715 的 1368/1369；没有修改断言，等待
既有 18:50 定时 projector 将两游标共同推进至 4162868 后，复查为 1369/1369，再跑全量
即 462/462。该现象与题述测试活库偶发依赖一致，不计作实现放宽或测试规避。

无功能阻塞；未 commit、未 push，未触碰 QQ 目录或发送 QQ 消息。
