# PAGEREF：effective 页面引用投影交付报告

日期：2026-08-06（Asia/Shanghai）  
分支/起点：`scpper-backend-v2` / `8d1384e`  
目标库：`scpper-v2`  
网络边界：本任务所有输入均来自 v2 PostgreSQL；零 Wikidot 请求，未访问 qqbot，未发送 QQ 消息。v1 仅使用 `SYNCER2_V1_DATABASE_URL` 做只读统计。

## 1. 结论

`serve.page_reference` 已从空表建成“每个页面当前 effective `source_sha` 的引用集合”，完成全量并接入固定安全水位的日常 projector：

- effective 源码页：47,989（`serve.page_current.source_sha` 非空；包含 deleted 身份保留的最后 effective 源码）。
- 投影行：341,050；聚合前出现次数：396,047；有引用的来源页 34,741，无引用 13,248。
- 内链 223,510 行；站外 http(s) 117,540 行。
- `TRIPLE` 183,331 行 / 204,763 次；`SHORT` 49,937 行 / 60,278 次；`DIRECT` 107,782 行 / 131,006 次。
- 内链解析：resolved 175,690；missing 47,817；ambiguous 3（站外另为 external 117,540）。
- slug 复用：22,414 行涉及 3,113 个复用 slug；其中 3,001 个恰一条 live、111 个零 live、1 个多 live。
- 唯一多-live 目标是 `scp-cn-4156`，候选 page_id 为 `[1500000206,1500001184]`，共有 3 行引用；全部 `resolution_status='ambiguous'` 且 `to_page_id IS NULL`，没有任选。

## 2. 建模决策：直接替换 effective 集合

采用“直接替换 + 保留既有 `page_reference_graph_snapshot`”，没有为每个历史修订建立 SCD2 明细：

1. 产品查询要的是当前图；历史版本引用不是本任务的事实口径。SCD2 会让常规反链查询额外携带时态条件，并重新制造 v1 的历史堆积。
2. 每行保存 `source_sha`，明确证明它来自哪个 effective 源码。源码轮动时，同一事务内先 upsert 新集合、再删除不在新集合中的旧键；读者看不到新旧并存的半成品。
3. 需要长期图指标时继续写 `serve.page_reference_graph_snapshot`；快照承载图演进，明细表保持当前态、易读且可重建。
4. 主键使用 `(from_page_id, kind, reference_key)`；`reference_key` 是 scope/key/fragment 的 SHA-256 固定宽度键，完整目标仍保存在 `target_key/target_path/target_fragment/raw_target`，长 URL 不截断。

`resolution_status` 是一等口径：

- `resolved`：目标 slug 恰有一个 current live 身份，填 `to_page_id`。
- `missing`：零个 live；引用保留，`to_page_id=NULL`。
- `ambiguous`：多于一个 live；引用和全部候选保留，`to_page_id=NULL`，绝不任选。
- `external`：站外 http(s)；完整 URL 保留，不伪装成缺页。

`candidate_page_ids` 保存同 slug 的全部当前身份行，`live_candidate_page_ids` 单独保存 live 子集；因此“历史身份复用但当前可唯一命中”和“真正多-live 歧义”不会混为一谈。

## 3. 解析口径

纯 TypeScript 解析器位于 `src/content/extractPageReferences.ts`，不含任何 HTTP 入口：

- `TRIPLE`：`[[[target|display]]]`；
- `SHORT`：`[target display]`；
- `DIRECT`：裸 http(s) URL；本站域名归一为内链，其他主机保留为 external；
- 本站域名、`www`、协议相对地址、星号、query、fragment、NFKC、路径 segment 和显示变体（最多 10 个）均显式归一；
- `javascript:`、`mailto:`、其他 URI scheme 与任一 segment 为 `local--files` 的目标不入页面引用。

同时修正 v1 的一个重大词法误报：v1 SHORT 只有右向 `(?!\[)`，会从 `[[div ...]]` 的第二个 `[` 起匹配，把 `div/include/span/module` 等 Wikidot 指令当成缺页。v2 要求 SHORT 两侧均为单方括号；旧库保持不变。仍需注意：这是词法解析，不是完整 Wikidot AST，正文/CSS 中真正的单方括号结构和裸 URL 仍可能形成候选；`style-display:` 等少量 missing 目标应在将来有 AST 时复审，当前通过 `resolution_status` 可隔离。

## 4. 增量管线与同一水位

迁移 `0038_page_reference_effective.sql` 给新 `ingest.page_source` 行增加 `change_seq`：BEFORE INSERT 先进入 `meta.ingest_gate_open()`，再分配全局 `ingest.fact_seq`。旧存量保持 NULL，由首次 effective 全量直接读取。

projector 的一轮仍由 `runProjections()` 在事务外钉死同一个 `targetSeq`，单投影内部继续执行 advisory lock、写冻结检查、`safe_seq_watermark()` 和二次钳制推进。增量来源分两类：

- `page_source.change_seq` 窗口：只重解析这些来源页当前 `page_current.source_sha`；即使插入的是历史源码指认，也只读取 effective sha。
- `page_life_event.seq` 窗口：新建/删除/恢复/改名只重新裁决受影响的 target slug；通过旧 `to_page_id`、候选数组和新 current slug 找回引用，不重读来源源码。

cursor=0 且目标表为空时自动做一次 effective 全量，避免旧存量没有 `change_seq` 时空跑；正常全量使用 `--rebuild`。最终游标为 3,830,898，`rebuild_from` 与表注释逐字一致；`checks/0001_projection_cursor_drift.sql` 报告 32/32 Tier-2 全覆盖。

## 5. 与 v1 对照

用户给定的 v1 基线为 4,048,851 行；本任务在 2026-08-06 13:06 CST 用服务端只读连接实测为 4,078,831 行（期间 v1 的其他写者仍在运行，本任务没有写 v1）。同一时点：

| 口径 | 行数 |
|---|---:|
| v1 全部 `PageReference` | 4,078,831 |
| v1 历史（`PageVersion.validTo IS NOT NULL`） | 3,676,285 |
| v1 effective（`validTo IS NULL`） | 402,546 |
| v2 effective | 341,050 |

全量差 3,737,781 行，主要不是覆盖不足，而是 v1 有 3,676,285 行历史版本引用；余下 effective 差 61,496 可按类型完全解释：

- SHORT：v1 200,603 → v2 49,937，减少 150,666，主要是 v2 不再把双括号 Wikidot 指令误判成 SHORT。
- DIRECT：v1 19,893 → v2 107,782，增加 87,889，主要是 v2 按要求保留站外裸 URL，v1 DIRECT 只接受本站域名。
- TRIPLE：v1 181,809 → v2 183,331，增加 1,522，来自两个库 effective 源码快照/覆盖时点差异。
- v1 另有历史口径遗留的 effective `INCLUDE` 241 行；本任务明确只实现 TRIPLE/SHORT/DIRECT，v2 不混入第四类。

覆盖不能用源行数直接比较：v1 `SourceVersion` 111,411 行覆盖 47,958 页，v2 `page_source` 78,680 行覆盖 47,989 页。v2 行数更少但页面覆盖多 31，且投影明确绑定 `page_current.source_sha`，不会因同页历史源码行多而被重复计数。

v2 更可信之处是：effective 口径物理唯一、精确 source sha 溯源、双括号误报已消除、站外/缺页/歧义可区分、slug 复用候选完整且只命中唯一 live。v2 不如理想 AST 的地方是剩余词法误报风险；另外它有意不提供逐修订引用历史和 INCLUDE 图，若未来产品需要，应从图快照或独立 AST 投影扩展，而不是把历史重新塞回当前表。

## 6. 回归与上线结果

- 新增 5 个测试：三种形态、外链与排除项、双括号误报、归一化、真实 DB 的复用/歧义/缺页/轮动/幂等。
- `npx tsc --noEmit`：通过。
- `npm test`：387/387 通过（基线 382 + 本任务 5）。
- page-reference 全量：47,989 页，341,050 行，约 60 秒，原子提交。
- 全量后普通增量：消费固定窗口 3,823,193..3,830,898，affected=0、written=0、deleted=0，游标正常追平。
- 迁移权限自检：PUBLIC 可执行 SECURITY DEFINER 数为 0；BFF 只读、projector 可 DML/TRUNCATE。
- 未 commit，未 push。
