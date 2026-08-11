# Syncer2 v2 图片链路交付报告（方案 A）

日期：2026-08-11（Asia/Shanghai）  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
分支/基线：`scpper-backend-v2` / `01be072`  
结论：代码、迁移、真实元数据导入、SHA 复用、回归均完成；未 commit、未 push、未触碰 qqbot、未发送 QQ。

## 1. 最终结果

执行期间 v1 图片 job 仍在活跃，用户给出的 47,201 行快照先增长到 47,385，第二轮又增长 1 行。
最终以 2026-08-11 20:25（UTC+8）的只读快照为准：

| 项目 | 结果 |
|---|---:|
| v1 READY `ImageAsset` 元数据 | 47,386 |
| v2 `serve.image_asset` 已迁移 | 47,386 |
| 文件存在、字节数与 SHA256 全通过，v2 `ready` | 47,384 |
| v1 标 READY 但文件缺失，v2 显式 `failed/file_missing` | 2 |
| v1 `PageVersionImage` 来源行 | 202,182 |
| 去重后 URL→SHA alias | 96,623 |
| v2 job 唯一 normalized URL 分母 | 66,496 |
| 唯一 SHA 安全命中 | 43,489（65.4009%） |
| 多 SHA 歧义（全部排除） | 154 |
| 仍需 worker 处理的唯一 URL | 23,007 |
| 零下载收敛的 page_image/job 行 | 54,754 |
| 当前 pending job 行 | 24,615 |

2 个缺文件资产没有被静默丢弃或伪装成 ready：

- v1 id 45361 / SHA `350fcb5b9a59a6a6bafb8b30454de99e0bf9bf32c74e67ffd061c7c2c3ca7ae0`
- v1 id 45362 / SHA `fd596cc78e90cba7a61da74a2d7eafb4cb2a14f59cd5520da1224ee2d572d561`

另有 66 个 legacy URL 行无法归一化，全部是含 `{$division}` 的模板占位引用；导入摘要按
`invalidUrlRows` 计数并保留样本，没有进入可复用候选。全部 47,386 条资产元数据仍已迁移。

## 2. 配置与迁移顺序

- 本机 `syncer2/.env` 与受版本控制的 `.env.example` 均配置
  `SYNCER2_IMAGE_ASSET_ROOT=/home/andyblocker/scpper-cn/.data/page-images`。
- `schedule:image-ingest` 同时显式传 `--asset-root`，即使生产 EnvironmentFile 漏变量也不会
  回落到 worktree；代码默认值也是同一持久目录。
- 先应用 `0055_v1_image_asset_reuse.sql`，再执行导入和运行新 worker。迁移已连续幂等重跑通过。
- 迁移新增 `serve.image_asset_url_alias`，物理保留 URL 的全部 SHA 候选；只有
  `count(DISTINCT asset_sha)=1` 且磁盘 SHA 当场复核通过才可免下载。
- alias 是可重建索引、没有 pending 语义，已登记 `not_pending`。检查同时发现历史 0044 的
  `forum_incremental_category_state` 漏登记；按真实 unswept 语义登记为 `covered` 并纳入
  `pending_collection_current`，没有修改/放宽 coverage 检查。

## 3. v1 只读与导入幂等

导入入口同时强制并验证：

1. `SYNCER2_V1_DATABASE_URL` 必须保留 `options=-c default_transaction_read_only=on`；
2. Client 连接 options 再次强制相同参数；
3. 服务端 `default_transaction_read_only=on`、`transaction_read_only=on`；
4. 所有来源读取包在 `REPEATABLE READ READ ONLY`；
5. `UPDATE "ImageAsset" ... WHERE false` 写探针由 PostgreSQL 以 SQLSTATE `25006` 拒绝。

写探针即使防线被误删也因 `WHERE false` 不可能改变行；实际正确路径在执行前已被 PG 拒绝。
最终只读复核仍为 `db=scpper-cn, default_ro=on, tx_ro=on, READY=47,386`。

幂等实测：首轮收敛 54,753 行；活跃 v1 新增 1 资产后第二轮只新增 1 资产/2 alias 并收敛
1 行。随后同一 47,386 资产、96,623 alias 输入再次执行，结果为：

```text
assetRowsTouched=0
aliasRowsTouched=0
referenceRowsResolvedThisRun=0
jobsCompletedThisRun=0
```

最终资产/alias/复用/队列计数与上一轮完全一致。upsert 带值相等 `WHERE ... IS DISTINCT FROM`
抑制无意义 UPDATE/WAL；SHA 与规范 URL 是稳定幂等键。

## 4. SHA 命中、原子落盘与 v1 零影响

复用路径对 v2 已知 URL 和 v1 alias 都执行相同检查：路径必须位于资产根、必须是普通文件，
并流式重算完整 SHA256。命中才提交 `page_image.asset_sha` 和 completed job；文件缺失回到下载，
内容不符以永久 `storage` 失败退出，绝不覆盖现有文件。

新文件发布顺序：同目录唯一 temp → `FileHandle.writeFile` → 文件 `fsync` → 再检查并发赢家 →
同目录 `rename` → 父目录 `fsync`。已存在且 SHA 相同直接返回，不修改；任何已有路径 SHA 不同
都显式失败。没有搬运 22GB，没有删除或改写任何 v1 文件。

回归用并发读最终路径验证：发布过程中最终名只能得到 `ENOENT` 或完整 8 MiB 文件，从未读到
部分长度；完成后无 `.tmp-*` 残留且 SHA 再验通过。缺路径用例还验证了确实调用下载一次并
原子补齐；已有路径用例验证下载次数为 0 且直接建引用。

## 5. 剩余下载量与耗时

23,007 个唯一 URL 尚无安全唯一 SHA，其中 154 个是多 SHA 歧义，必须按当前 URL 内容重新裁决。
默认 blocklist 中 `cdn.mer.run` 占 133 个，会本地终结为 `blocked_host`、不实际出站；因此最多
22,874 个 URL 会发生出站尝试（22,873 external + 1 wikidot_site）。同 URL 的额外 1,608 个
page job 会在首个下载成功后走本地复用，不会重复下载。

- 纯限速下界：external 1 req/s、wikidot 7.2 s/request，约 22,880 秒 = 6.36 小时。
- 调度为 420 秒短进程 + `OnUnitInactiveSec=1min`，无失败时约 7.3 小时清完网络工作量。
- 考虑 HTTP 延迟/退避，运行估计 8–10 小时；永久 4xx/blocked 会显式归类但不拖满重试预算。

## 6. 站外分流、健康度与可观测性

- `wikidot_site` 继续使用既有 `PostgresAdaptiveEgressGate(..., 'image')`，没有另起限速器。
- wdfiles/其它站外只用独立 1 req/s client，不接 Wikidot gate。
- CLI 对 unified、wikidot_site、external 分别调用统一 `evaluateRunHealth` 口径；external 失败
  可使整轮 unified 失败，但不会进入 wikidotSite 的失败率或 breaker。
- `meta.image_ingest_egress_health` 提供最近 1h 两条链路的成功率；processing 作为中间态不进
  分母，连续至少 10 个可判定结果零成功进入 oldest-pending critical。
- `checks/0004_image_pipeline.sql` 与 `checks/0005_pending_collection_coverage.sql` 均通过。

## 7. 回归与验收

- `npx tsc --noEmit`：通过。
- `npm test`：全绿；精简 reporter 完整复跑 `EXIT_CODE=0`。基线 462 项加本次 4 项回归，
  共 466/466。
- 新增/强化回归：本地 SHA 命中零下载、缺 SHA 下载与原子发布、站外失败健康分账、
  活库 health/registry 接线；既有断言未为变绿而放宽。
- `git diff --check`：通过；未 commit、未 push。

补充：`prisma/pull.sh --check` 仍报告既有 Prisma 读侧模型 103 与活库非分区表 118 的历史漂移；
本链路全程使用权威 SQL 迁移与 raw SQL，不依赖 Prisma 模型。这不是图片切流阻塞，但应另项清理。

## 8. 阻塞与切流动作

代码/schema/导入/复用没有阻塞。两个 v1 READY 缺文件已显式降级并回到下载路径；133 个
`cdn.mer.run` 引用按既有安全 blocklist 不会出站，是可见的内容缺口而非静默成功。

切流时仍需按方案 A 的运维步骤停掉 v1 图片 job，再启用 v2 `syncer2-image-ingest.timer`；本次没有
替用户执行服务停启。共享目录无需搬运，也不应做清理。
