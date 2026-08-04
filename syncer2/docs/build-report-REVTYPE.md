# syncer2 修订类型集合化修复报告

日期：2026-08-04  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
目标库：`scpper-v2`  
迁移：`migrations/0034_revision_type_set.sql`

## 1. 结论

`ingest.revision.type` 已从混合语义的 `text` 收敛为 PostgreSQL 原生 `text[]`。迁移、
实时采集、v1 回填、读取查询、Prisma 投影和回归测试现在共用一种表示：一个修订类型集合
就是一个数组；来源没有提供类型时使用 SQL `NULL`。

活库迁移结果：

| 指标 | 迁移前 | 迁移后 |
|---|---:|---:|
| `ingest.revision` 行数 | 519,944 | 519,944 |
| 明文具体类型 | 434,283 | 0 |
| JSON 数组文本 | 1,752 | 0 |
| 明文 `unknown` | 83,909 | 0 |
| SQL `NULL`（类型信息未提供） | 0 | 83,909 |
| `type` 的 PostgreSQL 类型 | `text` | `text[]` |
| 非法/非规范数组 | — | 0 |

迁移在同一活库上执行两次。第二次日志仍为 `before=519944`、`after=519944`，迁移前后
内容指纹不变；独立检查 `checks/0011_revision_type_set.sql` 通过。迁移期间没有新修订
插入，所以迁移前后行数可直接精确比较。

## 2. 数据口径与现场证据

迁移前对 `scpper-v2` 只读盘点得到：

- 总行数 519,944；最早/最晚 `observed_at` 为
  `2026-07-28 10:54:06.953+08` / `2026-08-04 18:44:56.12+08`。
- 434,283 行是单值明文，1,752 行是 JSON 数组文本，83,909 行是 `unknown`。
- JSON 形态包含 68 行 `SOURCE_CHANGED + TITLE_CHANGED`，证明该列不能再降为单值枚举。
- 21 行 `PAGE_RENAMED` 全部曾是 `["PAGE_RENAMED"]`；旧式
  `WHERE type = 'PAGE_RENAMED'` 因而返回 0。

迁移提交后的即时快照中，主要分布为：

| `type` | 行数 |
|---|---:|
| `{SOURCE_CHANGED}` | 304,066 |
| `NULL` | 83,909 |
| `{TAGS_CHANGED}` | 75,214 |
| `{PAGE_CREATED}` | 38,493 |
| `{FILES_CHANGED}` | 11,149 |
| `{TITLE_CHANGED}` | 6,902 |
| `{META_CHANGED}` | 91 |
| `{SOURCE_CHANGED,TITLE_CHANGED}` | 68 |
| `{SOURCE_CHANGED,TAGS_CHANGED}` | 28 |
| `{PAGE_RENAMED}` | 21 |

`'PAGE_RENAMED' = ANY(type)` 现返回 21 行；按成员查询
`SOURCE_CHANGED + TITLE_CHANGED` 返回 71 行，其中还包括三元素/四元素集合。

## 3. 迁移设计

### 3.1 为什么直接改列类型

实际触发器 `trg_immutable` 是 `BEFORE UPDATE OR DELETE FOR EACH ROW`，由
`ingest.fn_revision_immutable()` 实现。它禁止普通 DELETE，并只允许受控的
`wikidot_revision_id`、`type`、`source_sha` 单向后补；迁移上下文可绕过行级守卫。

本次选择：

```sql
ALTER TABLE ingest.revision
  ALTER COLUMN type TYPE text[]
  USING ingest.migrate_revision_type_text(type);
```

这是 DDL 表重写，不产生逐行 UPDATE 事件，因此不触发行级不可变守卫；迁移仍显式设置
`scpper.bypass_guard=on`。相比“新增列、UPDATE 全表、改名、删旧列”，直接改类型不会留下
双写窗口或两个真相源，也更符合不可变事实表的约束。

迁移先取得 `ACCESS EXCLUSIVE` 锁，再在同一个事务里固定 before/after 行集。它仅接受
`text` 或已迁移的 `_text` UDT：前者执行转换，后者跳过转换，其他列类型立即失败。
所以脚本可重跑，而且不会把意外 schema 静默吞掉。

### 3.2 转换规则

- 明文 `X` → `ARRAY['X']`；
- JSON 数组文本 `["X","Y"]` → `ARRAY['X','Y']`；
- 明文 `unknown` → SQL `NULL`；
- 重复元素去重，并按固定业务顺序规范化；
- 损坏 JSON、JSON 标量、空数组、空元素和未声明类型一律中止事务，不猜测修复。

迁移末尾同时断言：约束已完成全表验证、行数不变、`type::text LIKE '[%'` 为 0。

## 4. `unknown` 的调查与决定

### 4.1 v1 是否有可恢复信息

使用只读连接检查了 v1 `scpper-cn`；会话同时满足
`transaction_read_only=on` 和 `default_transaction_read_only=on`，没有修改 v1。

v1 `public."Revision"` 只有 `id/pageVersionId/wikidotId/timestamp/type/comment/userId`，
没有原始 marker、diff 或其它可还原类型集合的字段。v1 共 5,442,252 行修订，其中
108,618 行为 `unknown`；v2 中这 83,909 行全部来自 `v1_backfill` 的同一回填时刻。

### 4.2 为什么选 `NULL` 而不是空数组

`NULL` 表示“来源没有提供、无法恢复”；空数组表示“已经观察并确定不存在任何类型”。
这里缺的是观测信息，不是已经确认的空集合，所以 `NULL` 更诚实。库约束明确禁止空数组，
避免二者以后再次混用。实时采集有 marker 时仍必须写非空集合。

### 4.3 为什么不从 comment 推断

83,909 行中 38,783 行有 comment，但 comment 不是可靠分类源：v1 全库 20,128 个
非空 `unknown` comment 值中，3,311 个也出现在具体类型下，138 个横跨多个具体类型。
例如标签提示和回退说明都同时出现在 `SOURCE_CHANGED`、`TAGS_CHANGED`、
`TITLE_CHANGED` 或 `unknown` 中。comment 只能暗示发生过变化，不能恢复完整类型集合。

`source_sha` 也不能作为 `SOURCE_CHANGED` 的证据：历史 unknown 因保守抓取策略而可能带
源码快照，快照存在不等于源码发生变化。因此本次不做任何推断，不把不确定性伪装成事实。

## 5. 写入与读取适配

`src/collect/revisions.ts` 现在对解析出的 marker 去重、规范排序后，直接把数组放入 JSONB
批载荷，不再对数组做第二次 `JSON.stringify`。数据库函数
`ingest.apply_revision_batch()` 只接受 JSON array 或 null，并在任何副作用前将其转换为
规范 `text[]`；旧式字符串、空集合和非法元素会以 SQLSTATE `22023` 被拒绝。

读取端已统一改为数组语义：

- revision source 候选用数组 overlap/`unnest`，并把 `NULL` 视为需要保守抓取；
- user-page 投影用 `'PAGE_CREATED' = ANY(type)`；
- 跨来源 type 冲突比较数组集合，不再比较 JSON 文本；
- v1 回填把具体值变成单元素数组，把 `unknown` 变成 `NULL`；
- Prisma 字段改为 `String[]`，projector fixture 和 SQL smoke fixture 同步更新。

## 6. 防回归机制

防线不是只靠采集器约定，而是落在数据库边界：

1. 列本身是 `text[]`，JSON 数组文本不再是合法的列形态；
2. `revision_type_set_ck` 要求数组非空、无空元素、去重、顺序规范且元素属于词表
   （或显式的非空 `UNKNOWN:*` 前缀）；
3. `revision_types_from_jsonb()` 拒绝字符串标量，保证批 API 不能重新引入旧形态；
4. 不可变触发器只允许 `NULL → 具体集合` 的受控单向后补；已知集合不能被覆盖；
5. GIN 部分索引 `rev_type` 支持数组成员/overlap 查询；
6. 独立数据库检查持续断言列类型、约束有效、非法数组为 0、JSON 文本残留为 0。

## 7. 同类列审计

检查了 `syncer2/src/collect`、`src/store` 中全部 `JSON.stringify` / `toPgJson` 写入路径，
并与 Prisma/迁移 schema 中的结构化列交叉核对。未发现第二个“集合/结构被 JSON
序列化后塞进 text”的持久化缺陷。

| 列或数据域 | 实际类型 | 结论 |
|---|---|---|
| `serve.page_current.tags` | `text[]` | 集合，形态正确 |
| `revision_source_delta.before_tags/after_tags` | `text[]` | 集合，形态正确 |
| queue reasons、signals/freezes、image source hosts | `text[]` | 集合，形态正确 |
| `page_attr_history.value` | `jsonb` | 值可为标量/数组/对象，JSONB 合理 |
| queue payload/details、delta patch、image metadata | `jsonb` | 结构体，形态正确 |
| revision/forum/vote batch payload | 临时 `jsonb` API | 入库函数会拆成强类型列，不是 text 持久化 |
| `RevisionEntry.rawMarkers` / type histogram | 内存/JSONB 指纹 | 不写入 text 列 |
| 其余 `JSON.stringify` | 哈希、HTTP body、文件或日志 | 不属于数据库 text 存储 |

## 8. 验证结果

- 单元素 `{SOURCE_CHANGED}` 与多元素 `{SOURCE_CHANGED,TITLE_CHANGED}` 经真实
  `apply_revision_batch` 写入、回读一致；字符串标量被拒绝且不产生行；
- 迁移在空白临时库按 `0001…0034` 执行成功，并将 `0034` 再执行一次成功；
- 活库迁移执行两次，第二次行数和内容指纹不变；
- `checks/0011_revision_type_set.sql` 最终复查：519,951 行、83,909 个 `NULL`、JSON
  残留 0、明文 unknown 残留 0、非法数组 0；相对迁移快照新增的 7 行同样满足约束；
- `npx tsc --noEmit` 通过；
- Prisma validate、pull/check 与 103 个模型核对通过；
- `m3-collect.test.ts` 21/21、`revision-type-set.test.ts` 3/3 通过。
- `npm test` 全量 363/363 通过（基线 359，加本次 4 个防回归测试），0 fail、
  0 skipped；没有为活库偶发性修改断言。

## 9. 限制与后续

- `NULL` 历史行不会被猜测补型；若未来取得原始 revision marker，可经受控
  `apply_revision_batch` 做 `NULL → 具体集合` 的证据化后补。
- 旧迁移文件保留当时定义；新装库按编号执行到 `0034` 后得到最终 schema，避免改写历史。
- `migrations/smoke_test.sql` 的 revision 段已通过；完整 smoke 后续在一个既存 forum
  fixture 的 `description` 列处失败，与本次 revision 变更无关。正式回归依据为项目的
  TypeScript 全量测试。
- 未修改 v1，未触碰生产 checkout 或 `/home/andyblocker/qqbot`，未发送 QQ 消息。
