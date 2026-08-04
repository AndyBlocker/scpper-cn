# 页面父子关系审计与 serve 读模型（2026-07-29）

## 结论

`%%parent_fullname%%` 的采集本身完整，解析有两个缺口：

1. 8,975 个非空 parent 中 4 个未解析；它们都能由 `page_slug_history` 唯一证明为
   同一个已改名、仍存活的父页，并非新页或已删页。
2. 268 个被用作父页的 fullname 同时存在一个 live 页和至少一个 deleted 同名页。旧的
   通用 resolver 无排序，令其中 61 条边随机落到 21 个 deleted 同名 ID；`scp-835`
   甚至有子页被分到新旧两个 ID，证明这不是应保留的删除关系，而是初始解析歧义。

`0026_page_hierarchy.sql` 已经用正常 `apply_page_meta` 路径关闭旧 SCD2 区间：首次解析
唯一 live 优先，旧 fullname 只接受全历史唯一映射。现在 8,975/8,975 已解析、歧义错配
为 0，当前投影与 attr history 零不一致。

层级读取采用邻接表索引 + 防环递归函数，不建 closure/materialized path。当前只有
8,975 条边、最大深度 7；物化闭包会让 reparent 重写整棵子树，没有相称收益。

## 审计边界与口径

- 目标库：`scpper-v2`；所有审计查询以
  `default_transaction_read_only=on` 执行。v1 主库 `scpper-cn` 未发生任何写入。
- 初审时点：2026-07-29 11:41；修复复核时点：12:02（Asia/Shanghai）。任务给出的
  47,892 页在初审时已增长到 47,895 页，修复期间总页数未变。
- “原始 parent fullname”：`ingest.page_attr_history(attr='parent', valid_to IS NULL)`
  的 `value.slug`。
- “物理孤儿”：`page_current.parent_page_id IS NOT NULL`，但父 `page_current` 行不存在。
- “逻辑未解析”：原始 `value.slug` 非空，但 `value.page_id` 为空。
- 深度：无父页为 0，向父链每走一条边加 1；能抵达环的页面不混进正常深度分布。

## 数据正确性

### 解析

| 项目 | 修复前 | 修复后 |
|---|---:|---:|
| `serve.page_current` 总页数 | 47,895 | 47,895 |
| 非空原始 parent fullname | 8,975 | 8,975 |
| `parent_page_id` 非空 | 8,971 | 8,975 |
| 不同父 `page_id` | 1,778 | 1,778 |
| 逻辑未解析 | 4 | 0 |
| live/deleted 同名导致的错配边 | 61 | 0 |
| attr → current 投影不一致 | 0 | 0 |
| 物理孤儿 | 0 | 0 |

4 个修复对象是 `fragment:porn-hub-page-1` 至 `-4`，原始父 fullname 都是
`adult:porn-hub-page`。该 slug 在历史上只属于 `page_id=12124`；父页当前 slug 是
`porn-hub-page`，状态为 `live`。因此这是父页改名后子页仍返回旧 parent fullname，
不是新页、父页删除或身份缺失。

以后 Tier1 首次解析按“恰有一个 live 候选；否则当前候选必须唯一”裁决；失败后只接受
`count(DISTINCT page_id)=1` 的历史 slug。被删除重建复用过且没有唯一 live 候选的
歧义 slug 一律不猜，而是进入
`meta.pending_page(reason='listpages_parent_without_identity')`。

### 自引用、环与删除

- 自引用：0。
- 物理孤儿：0；迁移已加 `parent_page_id → page_current(page_id) ON DELETE RESTRICT`。
- 存量环：1 个双节点环、共 2 页：
  `component:classified-decoration (2762)` ↔
  `component:classified-decoration-base (2763)`。
- 该环两条边都是 Wikidot 字段直给值，没有独立证据裁决该删哪条，因此保留事实并显式
  报告；`page_subtree` 在重复节点返回 `is_cycle=true` 后停止。
- 写时触发器拒绝自引用、指向不存在父页以及任意长度的新环；parent 边变化用 advisory
  lock 串行化，并在事务提交前 deferred 复核，避免 READ COMMITTED 旧语句快照下并发
  A→B / B→A 各自校验通过。
- 当前指向 deleted 父页的子页是 0。审计前的 61/21 全部是上述无序 resolver 错配，
  不是可证明的历史父关系。
- 真正的父页删除仍按建议保留：v2 删除只翻 status，外键是 `ON DELETE RESTRICT`；
  Tier1 若再次看到相同 parent fullname，会优先保留子页已经建立的 parent ID，即使
  slug 后来被新 live 页复用，也不会仅凭同一个字符串擅自 reparent。回归测试覆盖了
  “已删父页保留”和“deleted + live 同名的首次解析选 live”两个不同场景。

### 深度分布

| 深度 | 页面数 |
|---:|---:|
| 0 | 38,920 |
| 1 | 6,680 |
| 2 | 1,510 |
| 3 | 710 |
| 4 | 67 |
| 5 | 3 |
| 6 | 2 |
| 7 | 1 |

另有 2 页能抵达上述环，不计入表内。最大无环深度为 7；深层实例符合多页作品连续分页
形状。最大直接子页集合是 `log-of-anomalous-items-cn` 的 1,246 页。

### 变更历史

修复后 parent 历史共有 36,248 个区间、36,155 个有当前 parent 观测的页面；
93 个区间已关闭。迁移前为 36,183 / 28，新增的 65 个关闭区间由 4 个旧 fullname
唯一补解和 61 个 live/deleted 同名纠错组成。实际 reparent 与“有父 → 无父”都会由
`apply_page_meta` 比较完整 parent JSON，未变零写入，变化时正常关旧开新，再同事务
更新 `page_current.parent_page_id`。

## serve 查询能力

```sql
-- 直接子页；默认包含 deleted 子页
SELECT * FROM serve.page_children(:page_id, true);

-- root + 整棵子树；深度上限 64，显式返回 path/is_cycle/depth_limited
SELECT * FROM serve.page_subtree(:page_id, 64, true);
```

`pc_parent_page(parent_page_id, page_id) WHERE parent_page_id IS NOT NULL` 同时支撑直接反查
和递归每一层。最大 fan-out 的 1,246 行实测约 2.3 ms。`include_deleted=false` 只过滤
输出，不截断遍历，所以 live 后代不会因为中间父页 deleted 而消失。

## ListPages 覆盖与 HTML 面包屑

当前 36,155 个最新 parent attr 中，27,180 个明确为无父，8,975 个非空；没有 selector
残留或无法解释的非空值。另做了 20 页分层在线抽样（10 个 parent 非空、10 个明确无父）：
HTML `#breadcrumbs` 与 `%%parent_fullname%%` 20/20 一致，0 请求失败、0 不一致。
面包屑链接也只有 fullname，无法区分 deleted/live 同名页，因此没有拿它为上述 61 条
身份歧义背书；那批纠错依据是“首次解析当前唯一 live 页面”的明确裁决规则。

这个样本不足以证明全站绝对没有假阴性，但数据没有显示需要引入第二真相源；而面包屑本身
也是 Wikidot parent 关系的渲染结果，并非独立事实。当前不增加整页 HTML 补采。后续只需把
“parent 为空但 HTML 有 breadcrumbs”的分层抽样纳入周期审计；一旦出现非零，再评估补采，
不要提前把两个来源混写进当前态。
