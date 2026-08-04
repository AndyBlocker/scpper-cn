# S3 用户偏差逐人归因（2026-07-28）

口径与查询固定在
[`checks/backfill_s3_user_attribution.sql`](../checks/backfill_s3_user_attribution.sql)：
`old` 是 v1 当前活页 `PageVersion` 上的 `LatestVote`，`new` 是 Jun-1
换源后的 A3 最终状态；偏差定义为
`abs(new-old) / max(old,1) > 5%`。查询以 `REPEATABLE READ READ ONLY`
运行于 `scpper-cn`。

## 结论

- 含已删页口径偏差大于 5%：9,377 人。
- 去掉已删页贡献后回到 5% 内：9,216 人。
- 活页口径仍偏差大于 5%：161 人；已逐人归因，未归因 0 人。
- 匿名票不进入用户行，本批残余中匿名用户为 0。

| 归因 | 用户数 | 含义 |
|---|---:|---|
| `v1_latestvote_without_source_event` | 141 | v1 `LatestVote` 仍有活页票对，但 `Vote`/legacy 折叠终态无该票对；属于 v1 派生终态脏/孤儿数据 |
| `crom_old_pageversion_scope` | 16 | CROM 事实落在旧 `PageVersion`；旧统计只看当前版本，A3 按页面自然键保留 |
| `legacy_current_pv_scope` | 4 | pre-cutoff legacy 终态存在；旧统计的“当前版本”接缝把它排除 |

候选机制只作为伴随信号而不强行充当归因：R2 时区证据 1 人、`±2`
原始值 1 人、存在 revote/revoke 中间态 7 人；三者均不能解释对应活页票对
差异。完整 161 人（含 ID、前后计数、差异页与证据）见
[`s3-user-attribution-2026-07-28.json`](s3-user-attribution-2026-07-28.json)。

典型样本：

| 类别 | user_id / wikidot_id | 用户 | old live | new live | 差异页 |
|---|---|---|---:|---:|---|
| v1 派生终态脏数据 | 14938 / 6346304 | caoanhe | 17 | 16 | 32589 |
| CROM 旧版本接缝 | 32524 / 4536321 | Lijsisjhsh | 5 | 6 | 105581 |
| legacy 当前版本接缝 | 15512 / 7109111 | astudent | 9 | 10 | 31399 |
