# legacy 投票 128,659 行差额归因

调查日期：2026-07-28（Asia/Shanghai）  
结论状态：可用于修订回填规格；历史 `128,659` 本身不能作为逐行差集继续使用。

## 结论先行

1. **日期过滤确实存在，但它解释不了 128,659。**
   `legacy-vote-import.ts` 的默认上界是 `2022-05-01T00:00:00Z`，严格取
   `legacy DateTime < cutoff`；在当前 `legacy_votes_cn.votes` 上只排除 **10,447** 行。
   真正执行 v1 写入的 `legacy-vote-migrate.ts` 默认上界是
   `2022-06-01T00:00:00Z`：它一边删除 cutoff 前的现有 v1 Vote，一边插入
   cutoff 前的 legacy votes；当前 legacy 表在该 cutoff 后为 **0** 行。
2. **`596,048 - 467,389 = 128,659` 混了两个不同口径。**
   `596,048` 是源表终态行；`467,389` 是 v1 先做跨版本去重和状态机折叠，
   再用“时刻不等于 00:00/08:00”识别出来的事件数。后者不是 legacy 行集合，
   也不是一次导入留下的行数。
3. **物理导入并没有少 12.8 万行。**
   全量逐行连接得到 **591,056 / 596,048（99.1625%）** 个 legacy 终态行在
   v1 中有相同 page、voter、direction、UTC 裸时间戳的副本；真正没有这种
   副本的只有 **4,992** 行。
4. **事件数变少主要是后续同状态观察被状态机吸收，用户假设在这个层面基本成立。**
   以 2026-07-28 10:20 的可复算快照看，596,048 个 legacy 终态行中有
   **133,403** 个没有作为独立 exact 事件存活；其中 **122,406（91.7566%）**
   的相同 page+voter 存在强 CROM 代理行，**10,997（8.2434%）**没有。
   重叠组方向 **122,370 同 / 36 异（99.9706% 同向）**，但时间戳并不相同：
   CROM 是晚到的日级状态观察，不是 legacy 秒级行的逐字节副本。
5. **v2 接缝应改到 2022-06-01，并由 legacy 终态给 CROM 状态机播种。**
   2022-06-01 前只取 legacy；v1/CROM 只从 2022-06-01 的 CST 墙钟日开始。
   接缝后首个 CROM 同向观察为 no-op，异向才生成 revote；接缝前冲突一律
   legacy exact 胜出并审计。
6. **legacy 段不应只读 `votes`。**
   `vote_history` 还有 6,116 行；与 `votes` 合并后共 **602,164** 行，键无重复，
   全部都是真实状态转移，含 3,327 次 revoke。按推荐规则最终应产生
   **602,164 条 legacy exact 事件**。
7. §3.1 的时区判断成立，但应收窄措辞：
   可连接的 **591,056** 行全部按
   `DateTime AT TIME ZONE 'UTC' = v1.timestamp` 命中；按 Shanghai 墙钟命中为
   **0**。其余 4,992 行在 v1 没有 exact 副本，不能拿来判断裸值基准。

## 1. 调查范围与口径

只读来源：

- 受保护 checkout：
  `/home/andyblocker/scpper-cn/backend/src/cli/legacy-vote-import.ts`
- 受保护 checkout：
  `/home/andyblocker/scpper-cn/backend/src/cli/legacy-vote-migrate.ts`
- v1 PostgreSQL：所有查询均在 `REPEATABLE READ READ ONLY` 或
  `READ ONLY` 事务内执行并 `ROLLBACK`
- `SPEC-backfill.md` 在当前 worktree 中不存在；§3.1 文本取自 2026-07-27
  留存的文件历史快照，其关键数字又由原审计 SQL 记录反查确认

本报告区分三种口径，不能互相直接相减：

| 口径 | 定义 |
|---|---|
| source row | `legacy_votes_cn.votes` 的终态行，一对 page+voter 一行 |
| physical clone | v1 任一 PageVersion 上有相同 page+voter+direction+timestamp 的行 |
| semantic event | v1 先执行 R1 跨版本精确折叠，再执行 R5 同 actor 状态机折叠后的转移 |

v1 `Vote` 没有 `source` 列，因此“CROM 行”只能使用代理定义：

- **宽代理**：同 page+voter 且 `timestamp >= '2022-05-14'`
- **强代理**：宽代理再要求 `timestamp::time IN ('00:00:00','08:00:00')`

以下把“CROM 重叠”的主数字按强代理报告；它是可复算的高置信代理，不是假装存在的来源真值。

## 2. 日期过滤逻辑

### 2.1 `legacy-vote-import.ts`：legacy 侧，默认 2022-05-01，右开区间

代码证据：

- 第 62 行：`DEFAULT_MAX_DATE = '2022-05-01'`
- 第 165 行：解析成 `${date}T00:00:00Z`
- 第 287–312 行：`vote_history` 与 `votes` 都要求
  `DateTime < timestamptz cutoff`
- 第 773–797 行：dump loader 对两个表都跳过 `timestamp >= cutoff`
- 第 1075–1083 行：MySQL 路径同样使用 `DateTime < ?`

所以它过滤的是 **legacy 侧两个表**，边界为：

```text
保留：DateTime <  2022-05-01 00:00:00+00
排除：DateTime >= 2022-05-01 00:00:00+00
```

这是上界严格 `<`；“含 5 月 1 日”的理解是错误的。

### 2.2 `legacy-vote-migrate.ts`：两侧换源，默认 2022-06-01

代码证据：

- 第 48 行：`DEFAULT_MAX_DATE = '2022-06-01'`
- 第 132 行：构造 `2022-06-01T00:00:00Z`
- 第 724–753 行：删除 cutoff 前的现有 v1 `Vote`
- 第 797–805 行：只插入 `legacy_votes_cn.votes` 中
  `DateTime IS NULL OR DateTime < cutoff` 的行

因此实际 apply 逻辑不是“只过滤 legacy”，而是 **cutoff 前用 legacy 替换现有
v1/CROM，cutoff 后保留原 v1/CROM**。

还有一个必须在 v2 中消除的类型陷阱：v1 `Vote.timestamp` 是
`timestamp without time zone`，代码却拿它与 `timestamptz` cutoff 比较。
边界会随数据库 session TimeZone 改变；当前 session 为 Asia/Shanghai 时，
`2022-06-01T00:00:00Z` 在 v1 裸值侧等价于 `2022-06-01 08:00:00`。
无法从代码本身证明当年 apply session 的 TimeZone，所以 v2 不应复刻这种隐式转换，
而应给两种源分别写明类型和解释。

### 2.3 哪个路径留下了当前数据库指纹

当前 legacy 源最晚为 `2022-05-31 21:09:14+08`，而 v1 中能找到
May 窗口的 8,292 个 UTC 裸 exact 副本。这与只导入 5 月 1 日前不符，
与 6 月 1 日换源路径相符。没有找到当年 CLI 实际参数或执行日志，因此这是数据库
指纹证据，不宣称为执行日志证据。

两个默认值都由提交 `c1fbba7` 引入；它们是两个阶段的不同默认值，不能只看到
`2022-05-01` 就把它当作最终 apply 接缝。

## 3. 过滤行数验证

只读快照：2026-07-28 10:24:29.627831+08。

| 检查 | 行数 | 占 596,048 |
|---|---:|---:|
| 全部 `legacy_votes_cn.votes` | 596,048 | 100% |
| `< 2022-05-01T00:00:00Z` | 585,601 | 98.2473% |
| `[2022-05-01T00Z, 2022-06-01T00Z)` | **10,447** | **1.7527%** |
| `>= 2022-06-01T00:00:00Z` | **0** | 0% |

结论：

- May-1 import filter 只解释 **10,447** 行，比 128,659 少 **118,212**；
- Jun-1 migrate filter在当前源表上排除 **0** 行；
- 因此“128,659 正好是按日期跳过的 legacy 行”被否证。

复算 SQL：

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT
  count(*) AS total,
  count(*) FILTER (
    WHERE "DateTime" < timestamptz '2022-05-01 00:00:00+00'
  ) AS pre_may,
  count(*) FILTER (
    WHERE "DateTime" >= timestamptz '2022-05-01 00:00:00+00'
      AND "DateTime" <  timestamptz '2022-06-01 00:00:00+00'
  ) AS may_window,
  count(*) FILTER (
    WHERE "DateTime" >= timestamptz '2022-06-01 00:00:00+00'
  ) AS post_jun
FROM legacy_votes_cn.votes;
ROLLBACK;
```

## 4. 128,659 为什么不是一个可归因的行差集

原始 467,389 的 SQL 已从 2026-07-27 审计记录中恢复：

```sql
WITH raw AS (
  SELECT pv."pageId" pid,
         COALESCE('u:'||v."userId"::text, 'a:'||v."anonKey") voter,
         v.timestamp ts, v.direction dir, pv."validFrom" vf, v.id vid
  FROM "Vote" v
  JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
),
dedup AS (
  SELECT DISTINCT ON (pid,voter,ts)
         pid,voter,ts,sign(dir) dir
  FROM raw
  ORDER BY pid,voter,ts,vf DESC NULLS LAST,vid DESC
),
ordered AS (
  SELECT *, lag(dir) OVER (PARTITION BY pid,voter ORDER BY ts) prev
  FROM dedup
),
events AS (
  SELECT * FROM ordered WHERE dir <> COALESCE(prev,0)
)
SELECT count(*) FILTER (
  WHERE ts::time NOT IN (time '00:00:00', time '08:00:00')
) AS legacy_exact_events
FROM events;
```

它在当时返回 467,389。这个数有三层语义变换：

1. 同一 v1 Vote 在不同 PageVersion 上的拷贝先被 R1 去重；
2. 同 page+voter 的同向重复观察再被 R5 吸收；
3. 最后仅凭时刻排除 00:00/08:00，把剩余事件当作“legacy exact”。

所以该数字既会漏掉恰好发生在 00:00/08:00 的 legacy 行，也可能纳入其他秒级行。
它没有保留可与 596,048 做集合差的 row identity。

当前同一 SQL 在 2026-07-28 10:20 快照得到 464,234，而不是 467,389；
v1 是仍在变化的在线库。没有 2026-07-27 的 MVCC 快照或导出的 row set，
不能诚实地把历史 128,659 精确拆成两个集合。

当前快照还可直接看到代理指标的集合污染：

| 当前口径 | 行数 |
|---|---:|
| “非 00/08”代理事件 | 464,234 |
| 其中能映射到 legacy 源行 | 462,643 |
| 代理事件但不是 legacy 源行 | 1,591 |
| legacy exact 事件中恰为 00/08、被代理漏掉 | 2 |

## 5. 可复算的逐行归因

### 5.1 物理导入视角：真正没有 v1 UTC exact 副本的只有 4,992 行

把 legacy Wikidot page/user 映射到 v1 id 后，在所有 PageVersion 上找
`page+voter+direction+timestamp`：

| 集合 | 行数 | 占源表 |
|---|---:|---:|
| legacy 终态行 | 596,048 | 100% |
| v1 有 UTC 裸 exact 副本 | **591,056** | **99.1625%** |
| v1 无 UTC 裸 exact 副本 | **4,992** | **0.8375%** |

4,992 行再按相同 page+voter 分：

| 判定 | 重叠 | 纯 legacy / 无重叠 |
|---|---:|---:|
| v1 任意时刻存在相同 page+voter | 3,081 | 1,911 |
| 存在强 CROM 代理 | **2,420** | **2,572** |

2,420 个强 CROM 重叠中，方向相同 **2,388**、不同 **32**，方向一致率
**98.6777%**。这些行按定义没有 UTC exact 副本，故不能声称时间戳一致。

这组数字最直接回答“当年导入是否因日期过滤漏了 12.8 万源行”：没有。

### 5.2 语义事件视角：被 R1/R5 吸收的 133,403 行多数与 CROM 状态重叠

为回答用户真正关心的“双计风险”，将每个 legacy 源行与当前 v1 R1+R5
事件流逐行连接：

| legacy 源行去向 | 行数 | 占源表 |
|---|---:|---:|
| 作为 UTC exact 语义事件存活 | 462,645 | 77.6187% |
| 被 R1/R5 吸收 | **133,403** | **22.3813%** |

对被吸收的 133,403 行：

| 归因 | 行数 | 占被吸收集合 |
|---|---:|---:|
| 相同 page+voter 有强 CROM 代理 | **122,406** | **91.7566%** |
| 没有强 CROM 代理 | **10,997** | **8.2434%** |

重叠方向：

| 最早强 CROM 代理 vs legacy | 行数 |
|---|---:|
| 同方向 | **122,370** |
| 方向冲突 | **36** |
| 同方向率 | **99.9706%** |

重叠时间：

- exact 同时间戳：**0**
- `CROM proxy timestamp - legacy timestamp`：
  min -16.52 天，p25 385.73 天，median **690.57 天**，
  p75 1,094.80 天，p95 1,521.94 天，max 2,331.81 天

这证明它们通常不是同一时刻的重复行，而是：

> legacy 记录了秒级真实转移；CROM 在数月或数年后再次观察到相同终态。
> 如果两边都从空状态各自重放会双计；如果以 legacy 终态播种后按 actor 状态机消费
> CROM，同方向观察自然成为 no-op。

“无强 CROM 代理”的 10,997 行不等于已证实丢失：其中可包含 PageVersion 拷贝选择、
早期非日零点行、方向变化后被状态机吸收等。由于 v1 无 source 列，只能把它们列为
未被高置信 CROM 代理解释的剩余项，而不能武断删除。

## 6. §3.1 UTC 裸值的全量核验

校验键为映射后的 page+user+direction，并跨全部 PageVersion 搜索：

| 时间解释 | 命中 |
|---|---:|
| `legacy.DateTime AT TIME ZONE 'UTC' = v1.timestamp` | **591,056** |
| `legacy.DateTime AT TIME ZONE 'Asia/Shanghai' = v1.timestamp` | **0** |
| 没有 UTC exact 副本，无法判断 | **4,992** |
| legacy page 映射缺失 | 0 |
| legacy user 映射缺失 | 0 |

因此，先前 20 万样本的结论在**所有可连接行**上成立：命中者 100% 是 UTC 裸值，
没有一行支持 CST 墙钟解释。规格不应写成“596,048 行全量都在 v1 逐行验证通过”，
而应写成：

> legacy 源 596,048 行中，591,056 行在 v1 有方向一致的 exact 副本；
> 这些副本全部按 UTC 裸值匹配，CST 墙钟匹配为 0。另 4,992 行在 v1
> 没有可供时区判定的 exact 副本。

## 7. v2 回填的明确规则

### 7.1 legacy 段输入

1. 读取
   `legacy_votes_cn.vote_history UNION ALL legacy_votes_cn.votes`，不是只读 `votes`。
2. 映射 Wikidot page/user；当前两个表的 page/user 映射缺失均为 0。
3. legacy 时间条件显式写为：

   ```sql
   "DateTime" < timestamptz '2022-06-01 00:00:00+00'
   ```

   当前源在该边界后为 0 行；同时设 gate，未来若出现边界后行立即中止，而非静默吸收。
4. 按 `(PageId, UserId, DateTime)` 去重；相同键 final `votes` 优先
   （与现有 import SQL 的 `ORDER BY source ASC` 实际顺序一致）。
   当前 602,164 行没有重复键。
5. 每 `(page,user)` 按原生 `timestamptz` 排序并做状态机：
   无票→±1 为 vote，±1→∓1 为 revote，±1→0 为 revoke，同状态才丢弃。
6. 输出统一为 `source='legacy'`、`time_precision='exact'`，保留原始 Value、
   DeltaFromPrev、来源表和源键到审计暂存区。

### 7.2 CROM / v1 段输入

1. v1 `Vote.timestamp` 是 CST 墙钟裸值，条件必须显式同类型：

   ```sql
   timestamp >= timestamp '2022-06-01 00:00:00'
   ```

   转为 v2 `occurred_at` 时显式
   `timestamp AT TIME ZONE 'Asia/Shanghai'`。不要再比较
   `timestamp without time zone` 与 `timestamptz`。
2. 2022-05-14 至 2022-05-31 的 v1/CROM 行不进入事实流；它们只进入
   `meta.dedup_audit` 作接缝对账。这样复刻了实际迁移的“Jun-1 前 legacy、
   Jun-1 后现有 Vote”换源意图。
3. v1 段仍先做 R1：同 `(page,voter,timestamp)` 保留最新 PageVersion，
   再做 direction `sign()` 归一化。
4. 用 legacy 段每个 `(page,voter)` 的终态作为 CROM 状态机初值：

   - 首个/后续 CROM 与当前状态同向：不产生事件，只记重复观察审计；
   - 方向改变：产生 revote；
   - 显式 0 且当前有票：产生 revoke；
   - 当前无票且观察为 0：不产生幻影 revoke。

### 7.3 接缝冲突裁决

| 情况 | 裁决 |
|---|---|
| Jun-1 前 legacy 与 CROM 同向 | legacy exact 保留；CROM 丢事实、留审计 |
| Jun-1 前方向冲突 | legacy exact 胜出；CROM quarantine/dedup_audit，不改写 legacy |
| Jun-1 后 CROM 与 legacy 终态同向 | no-op |
| Jun-1 后首个 CROM 与 legacy 终态异向 | 作为合法 revote，时间精度为 day |
| deleted page 无外部真相 | legacy 终态为接缝权威，迁移后按既定冻结规则处理 |

上文 36 个方向不一致组跨越整个后续 CROM 时段，不能全部叫作“接缝冲突”：
Jun-1 前按 exact legacy 裁决，Jun-1 后则应按状态机视作可能的合法 revote。
不能用 99.97% 的多数同向率把这 36 个组自动删除或改写。

### 7.4 最终 legacy 事件数

只读全量状态重放结果：

| 项目 | 行数 |
|---|---:|
| `vote_history` | 6,116 |
| `votes` | 596,048 |
| 合并源行 | **602,164** |
| `(page,user,timestamp)` 去重后 | **602,164** |
| 状态机转移事件 | **602,164** |
| 其中 revoke | **3,327** |

`votes` 中有 2,654 个 Value=0 的终态行，且 **2,654 个全部有 history 前态**。
若只按当前 §3.1 写法读取 `votes`：

- 直接把 596,048 行都写成事件，会制造 2,654 个“无前态 revoke”；
- 用正确状态机从空态重放，只会输出 593,394 个事件，却丢掉这些 revoke 的历史；
- 两种做法都不如合并 `vote_history` 的 **602,164** 条完整、合法事件链。

因此推荐且可验收的最终数字是：**602,164 条 legacy 段事件**。

## 8. 上线前 gate

1. legacy 原始行 `602,164`，去重后 `602,164`，状态转移 `602,164`；
2. legacy page/user 映射缺失均为 0；
3. legacy `DateTime >= 2022-06-01T00:00:00Z` 为 0；
4. 每个 `(page,voter)` 的 legacy 重放终态与 `legacy_votes_cn.votes.Value` 相等；
5. 首事件只能是 vote，不能是 revoke；当前 2,654 个零终态必须都有前态；
6. Jun-1 前 v1/CROM 事实事件为 0，所有命中只进 dedup audit；
7. Jun-1 后 v1/CROM 以 legacy 终态播种，同向首观察事件数为 0；
8. 方向冲突逐条有双指针审计，不能静默覆盖 exact；
9. exact 事件只能来自 legacy；进入事实流的 Jun-1 后 v1/CROM 只能是 day，
   被排除的早期 clamped/bootstrap 只留审计；
10. 最终 `vote_current` 按 page+voter、页面 rating、up/down/zero 分布分别对账。

## 9. 限制与可信度

- **高置信**：两段代码的默认 cutoff 与比较符、legacy cutoff 计数、UTC exact
  匹配、history+votes 状态重放；均有静态代码或只读全量 SQL 支撑。
- **中高置信**：122,406 个 CROM 重叠；v1 没有 source 列，使用的是明确披露的强代理。
- **不可恢复**：历史 467,389 对应的逐行集合。原查询只留下聚合结果，v1 此后仍在变化；
  所以不能把历史 128,659 伪装成可精确拆分的 row set。
- 本报告只写调查文档；未修改代码、迁移或数据库。
