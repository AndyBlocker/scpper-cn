# syncer2

SCPper CN **v2 采集层**。

> **数据源定位是一个未闭环的决策，不要把本文开头当成结论。**
> 本项目的任务前提是"wikidot 直连是唯一常驻源，CROM 仅在并行期作为免费金丝雀"，
> 但这个前提**反转了两份已定稿文件**（`docs/data-model-v2-redesign-2026-07-03.md`
> §5.8/§7 写的是"CromAdapter = 权威全量，WikidotAdapter 可选不阻塞"；2026-07-24 双轨备忘
> 写的是"票史时间戳永久 CROM 权威"），且反转时没有留下书面理由。
> 2026-07-27 的实测**不支持**这次反转（撤票退回未解决、11,804 已删页结构性不可见、
> 解析静默变形会把脏数据写进 append-only 表）。
> **完整的理由 / 代价 / 立场见 `../docs/data-model-v2-addendum-2026-07-27.md` §4。**
> 采集层代码本身对这个决策是中立的 —— 它只负责"从 wikidot 拿到数据并落 v2"，
> CROM 是不是权威源不改变任何一行采集代码。

与 `../syncer`（v1）的关系：**没有关系**。syncer2 是新项目、新数据库（`scpper-v2`）、
新表名（四 schema：`ingest` / `serve` / `app` / `meta`）。v1 保持运行、只读、不改动。
两套并行 2–3 周对账后再迁移下游。

> 四 schema 的 DDL 现在**就在本目录的 `migrations/` 下**，并已在真实新库 `scpper-v2` 上
> 跑通（见下「数据库迁移」）。采集层代码按定稿的表名/列名写入；表尚未落地时各写入函数
> 优雅降级，并在 JSON 摘要里标出 `slugResolution: "unavailable"` / `pageScansWritten: 0`。

---

## 本次交付的内容

| 模块 | 文件 | 职责 |
|---|---|---|
| **迁移** | `migrations/0001`–`0100` + `apply.sh` | 四 schema DDL（88 表 + 1 视图）+ 46 个函数 + 不可变触发器 |
| **冒烟** | `migrations/smoke_test.sql` | 296 个断言把写路径逐条跑通（末尾 `ROLLBACK`，不留数据） |
| **只读断言** | `checks/*.sql` + `checks/run_checks.sh` | 落地后的结构/登记/接线漂移检测（纯只读，可对生产库跑） |
| **测试** | `tests/*.test.ts`（7 个文件） | `npm test` = **102 通过 / 0 失败**：HTTP 护栏 / 解析红线 / 时区回环 / 出口归因 / 游标安全（多会话）/ 投票批量与属性生成器 / 权限矩阵 |
| **回填 gate** | `checks/load_v1_identity.sh` + `checks/backfill_finalize.sql` | Phase 2 回填的前置载入器与 50 条收尾断言（对 v1 只读） |
| **授权** | `migrations/9001_create_roles.sql.ADMIN` + `9002_grants.sql` | 9000 的拆分：DBA 只跑 5 条 `CREATE ROLE`，其余授权矩阵 + 权限边界强制自检由应用账号跑 |
| **DBA 交接** | `docs/dba-handoff.md` | 两项特权动作的完整步骤 / 验证方法 / 不做的后果 / 回滚；含"无 superuser 通道"的四条实测证据 |
| **语义检索决策** | `docs/embedding-migration.md` | `PageEmbedding` 的归属、"切换时全量重算"的实测依据与 23.1 小时成本账 |
| **Prisma 映射** | `prisma/schema.prisma` + `prisma/pull.sh` | v2 的**只读侧类型来源**（84 model / 4 schema）；`pull.sh` 是唯一维护入口 |
| **设计修订** | `../docs/data-model-v2-addendum-2026-07-27.md` | 设计文档的修订附录（不改原文）：被推翻的结论、R1–R15 落地状态、六个 blocker、唯一常驻源决策的代价 |
| HTTP 层 | `src/http/client.ts` | 请求头契约自检、per-client dispatcher、503/重置独立熔断、逐请求遥测 |
| 出口归因 | `src/http/egress.ts` | IP 回显探针（池构成）+ mihomo `chains[0]`（按连接真值）⇒ `meta.ingest_run.exit_ip_stats` |
| 启动自检 #3 | `src/http/amc.ts` | 真实 AMC POST 契约探针 + 代理健康（抓"静默回落直连"） |
| sitemap 解析 | `src/sitemap/parse.ts` | 正则解析 + 四道结构断言（根元素、**根元素闭合**、条目数>0、每条有 `loc`；绝不把失败解析成"0 条"） |
| sitemap 归一化 | `src/sitemap/normalize.ts` | slug 归一化 + 去重 + `parse_drop_rate` 的**唯一产地**（纯函数，可单测） |
| sitemap 抓取 | `src/sitemap/fetch.ts` | index → page/thread/category 全族，gzip 传输 |
| DB 层 | `src/store/db.ts` | pg 池 + **时区硬守卫**（裸 Date 拒收 + 已知 epoch 回环自检） |
| meta 写入 | `src/store/meta.ts` | `ingest_run` / `page_scan` / `scan_task` 的写入门面 + slug→page_id 解析 |
| 本地快照 | `src/store/snapshot.ts` | 跨短进程传递上一轮 sitemap 状态（原子写、损坏即 bootstrap） |
| 队列 | `src/store/queues.ts` | `meta.pending_page` / `meta.forum_scan_task` 的入队与认领（发现侧 UPSERT 绝不覆盖执行侧状态） |
| CLI | `src/cli/sitemap-scan.ts` | 单次短进程，stdout 单行 JSON，失败非零退出 |
| CLI | `src/cli/resolve-pages.ts` | 消化 `pending_page`：整页 GET → `WIKIREQUEST.info.pageId` → `register_page`；逐页独立容错 + 冷启动闸 |
| 正文提取 | `src/content/extractText.ts` | 零依赖正文提取（embedding 重算的输入端原型） |
| 设计约束备忘 | `src/README.md` | **每条架构选择对应的那次故障或实测**，建议先读这份 |
| sitemap 周期实测 | `experiments/sitemap-probe.md` | TTL ≈60 min、排序键不是 lastmod、枚举域差异逐条平账 |

---

## 数据库迁移

### 新库名：`scpper-v2`

与 v1 生产库 `scpper-cn` **物理隔离的独立库**，同一个 postgres 实例（`localhost:5434`）。
库名带连字符，psql/连接串里一律用引号或 URL 形式：

```
postgresql://user_dxzbdi:<pw>@localhost:5434/scpper-v2
```

`scpper-cn` / `scpper-syncer` / `scpper_user` 三个库在并行期**只读**。这条约束有两道物理闸：

1. 每个迁移文件开头的 `DO` 块：`current_database()` 落在 `scpper-cn` / `scpper_cn` 即 `RAISE EXCEPTION`；
2. `apply.sh` 的目标库黑名单（含 URL 解码，防 `scpper%2Dcn` 绕过）。

### 如何应用

```bash
# 应用全部迁移（增量；库已存在时用这个）
cd syncer2/migrations
./apply.sh --database-url "postgresql://user_dxzbdi:<pw>@localhost:5434/scpper-v2"

# 应用 + 冒烟验证
./apply.sh --database-url "..." --smoke

# 其它选项
./apply.sh --dry-run                        # 只打印执行顺序
./apply.sh --only 0006_functions.sql        # 单文件（可重复给）
./apply.sh --skip 0005_indexes_pgroonga.sql # 跳过（可重复给）
```

#### 从零重建（**推荐的验证姿势**，2026-07-27 整合期实跑过一遍）

v2 是空库，任何"结构疑似漂移"都不要修补，直接重建。下面这串命令逐条实跑过、零错误：

```bash
cd syncer2
set -a && source .env && set +a
ADMIN_URL="${SYNCER2_DATABASE_URL%/scpper-v2}/postgres"

# ① 重建空库（WITH (FORCE) 会踢掉残留连接；LOCALE 必须与原库一致）
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS "scpper-v2" WITH (FORCE);' \
  -c $'CREATE DATABASE "scpper-v2" ENCODING \'UTF8\' LOCALE \'C.UTF-8\' TEMPLATE template0;'

# ② 应用全部迁移（第一遍）
./migrations/apply.sh

# ③ 幂等验证（第二遍；只应出现 already exists / does not exist, skipping 的 NOTICE）
./migrations/apply.sh

# ④ 冒烟 296 条
psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/smoke_test.sql | tail -5

# ⑤ 只读漂移断言（投影登记 + 熔断接线）
./checks/run_checks.sh

# ⑥ 语义检索域冒烟（pgvector 缺失时 11 通过 / 2 跳过属预期）
psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 -f checks/embedding_smoke.sql | tail -3

# ⑦ 全部 TS 测试（离线 + 真连库，102 条）
npm test
```

⚠ **`DROP DATABASE` 前先确认目标库名。** `apply.sh` / `run_checks.sh` / `pull.sh` /
`load_v1_identity.sh` 各自带受保护库黑名单，但**这条 `psql -c 'DROP DATABASE …'` 没有**
——它是直接发给服务器的，任何闸都拦不住手抖。

不给 `--database-url` 时读 `$SYNCER2_DATABASE_URL`，再退到 `$DATABASE_URL`。
出错时打印**出错文件 + 行号 + ERROR/DETAIL/HINT 摘要**，并保留完整日志路径。

### 执行顺序与依赖

| 顺序 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| 1 | `0001_ingest.sql` | 身份层 + append-only 事实层 + 论坛域；`vote_event` 按 `seq` RANGE 分区 | — |
| 2 | `0002_serve.sql` | Tier-1 三表 + Tier-2 二十七表；views 只读守卫、tick append-only 守卫 | 0001 |
| 3 | `0003_meta.sql` | 16 张管道状态表（run / page_scan / scan_task / gate / cursor / quarantine / revoke_candidate / parse_health_baseline …） | 无（可独立跑） |
| 4 | `0004_app.sql` | BFF 与分析 job 的可写域 14 表 + 5 个原生枚举 | 0001 |
| 5 | `0005_indexes_pgroonga.sql` | 全文索引，扩展缺失时自动降级 | 0001 + 0002 |
| 6 | `0006_functions.sql` | 10 个 `apply_*` + 不可变/白名单/SCD2 触发器 + 游标安全机制 | 0001 + 0002 + **0003** |
| 7 | `0007_meta_gaps.sql` | `scan_task`/`page_scan` 词表补齐 + `meta.write_freeze`（R10 熔断物理开关）+ Tier-2 投影登记（首遍 27，`0008` 落地后重跑得 31） | 0002 + **0003** |
| 8 | `0008_serve_embedding.sql` | 语义检索域：`text_chunk` / `chunk_embedding` / `page_semantic` + 两张契约表 + `embedding_backlog` 视图；**pgvector 缺失时降级跳过向量段** | 0001 + 0002 + 0003 |
| 9 | `0009_serve_modeling_decisions.sql` | 两处产品决策的落地（红链、标签维度趋势），**可整体回退** | 0002 |
| 12 | `0012_collector_queues.sql` | `meta.pending_page` + `meta.forum_scan_task` 两张采集队列表 | 0001 + 0003 |
| 100 | `0100_backfill_gate.sql` | Phase 2 回填的暂存/留痕三表 + 身份序列收窄为 int4 域；**读切换后可退役** | 0001 + 0003 + 0006 |
| — | `smoke_test.sql` | 冒烟验证（`--smoke`） | 全部 |
| **9002** | **`9002_grants.sql`** | 授权矩阵 + 权限边界强制自检；**角色不存在时跳过不报错** | 0001–0004 + 0006 |
| — | `9001_create_roles.sql.ADMIN` | **只有 5 条 `CREATE ROLE`**（~50 行） | **需 DBA / CREATEROLE** |
| — | `9000_roles_grants.sql.ADMIN` | 建角色 + 全部授权的大而全旧版，**保留作备选** | 需 superuser |

**9001/9002 是 9000 的拆分，推荐路径是 9001 + 9002**（理由与实测见下「角色与授权」一节，
执行步骤见 `docs/dba-handoff.md`）。`9002` 按 `[0-9]*.sql` 被 `apply.sh` 自动纳入序列、
排在最后；`.ADMIN` 后缀的两个文件不进序列。

**0003 必须先于 0006。** `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，两者对
`meta.revoke_candidate` 的形状一旦分叉，先跑的那份就是最终形状，后跑的函数在**运行期**
才炸（`column "confirmations" does not exist`）。整合试跑真的踩到过这一条，两处已对齐。

**编号空洞是有意的。** `apply.sh` 按 `ls [0-9]*.sql | LC_ALL=C sort` 执行，允许空洞。
0007–0012 是六个并行任务各自占号的结果；0100+ 是「Phase 2 专属、读切换后可退役」的独立区段。
（整合期把原先与 `0008_serve_embedding.sql` 同号的 `0008_serve_modeling_decisions.sql`
改号为 **`0009_`** —— 同号文件靠 `LC_ALL=C sort` 的字母序决定先后，那是**能跑通但不该留**的状态。）

全部文件幂等：**连跑两遍已实测零错误**，第二遍只有一堆 `already exists, skipping` NOTICE。
⚠ 幂等 ≠ 收敛：`IF NOT EXISTS` 只保证重跑不报错，不保证重跑后结构等于文件内容。
**改结构一律新开 `0007+` 的 ALTER**；试跑期重置请直接 `DROP DATABASE` 重建。

### 落地后的对象清单（实测）

下表是 **2026-07-27 从零重建后逐条 `pg_class` 数出来的**（不是文件里的期望值）：

| schema | 表 | 说明 |
|---|---|---|
| `ingest` | 18（13 普通表 + 1 分区父表 + 4 分区） | `vote_event` 分区：`p0000`（冷回填）/ `p0001` / `p0002` / `pdefault`（必须恒空） |
| `serve` | 34 + 1 视图 | Tier-1 三张 + Tier-2 三十一张（0002 的 27 + 0008 的 4），每张都有 `rebuild_from` 注释；视图 = `embedding_backlog` |
| `meta` | 22 | 0003 的 15 张 + 0006 的 `fact_quarantine` + 0007 的 `write_freeze` + 0012 的 2 张 + 0100 的 3 张 |
| `app` | 14 | 收藏 / 关注 / 偏好 / 告警 / 追踪 / 标签 |

合计 **88 表 + 1 视图**。`serve.chunk_embedding` 因 pgvector 缺失**未创建**（装好扩展重跑 0008
即补齐，届时 serve 为 35 表 / Tier-2 为 32 张）。

函数 **46 个**：`ingest` 24 个（21 个 `SECURITY DEFINER`）、`meta` 16 个（13 个 `SECURITY DEFINER`，
其中 0007 新增 6 个：`write_freeze` 五件套 + `freeze_bypass_enabled`）、
`serve` 6 个（4 个守卫函数 + `0009` 的 `normalize_target_slug` + `0008` 的 `semantic_coverage`）。
`apply.sh` 尾部的负向断言「SECURITY DEFINER 函数不得对 PUBLIC 可执行」实测 **0**
（0007 §4 自己 `REVOKE`，因为 0006 第 8 节只扫它运行那一刻存在的函数）。触发器：`ingest` 侧 8 张表各挂 `trg_immutable` + `trg_no_truncate`，
且 `vote_event` 的 4 个分区**逐分区补挂**（语句级 TRUNCATE 触发器不从父表传播）。

### pgroonga 不可用 —— 已自动降级为 pg_trgm

实测：`pgroonga 4.0.6` 在这台机器上**装了二进制但没建扩展**，且它不是 trusted extension
（控制文件无 `trusted = true`），`CREATE EXTENSION pgroonga` 需要 superuser。
`user_dxzbdi` 不是 superuser ⇒ 失败。`0005_indexes_pgroonga.sql` 的三级降级按设计生效：

```
NOTICE:  [0005] pgroonga 扩展不可用（permission denied to create extension "pgroonga"），转入降级方案
WARNING: [0005] 已降级为 pg_trgm GIN 索引 7 条。
```

7 条降级索引：`u_display_pgroonga_trgm` / `u_username_pgroonga_trgm` / `fp_search_trgm` /
`fp_title_search_trgm` / `pc_search_trgm` / `pc_title_search_trgm` / `pc_alt_search_trgm`。

**这不只是"慢一点"**：trgm 只能加速 `ILIKE '%kw%'`，**不支撑 `&@~`**。
在真实 `scpper-v2` 上实测确认，没有扩展时 `&@~` 是**硬报错**：

```
scpper-v2=> select count(*) from ingest."user" where display_name &@~ '测试';
ERROR:  42883: operator does not exist: text &@~ unknown
```

⇒ 读侧如果只写了 pgroonga 分支，读切换当天全文搜索是 **500 报错**而不是变慢。
上线前必须二选一：DBA 执行 `CREATE EXTENSION pgroonga;` 后重跑 `0005`，
或者 BFF 侧实现 ILIKE 回退分支（代价：中文分词能力丧失，trgm 对 CJK 是 3-gram、召回噪声大）。

**这条路已经完整演练过**（2026-07-27，一次性容器 PostgreSQL 17.10 + pgroonga 4.0.6，
与宿主版本逐位相同，跑完即销毁）：

| 步骤 | 结果 |
|---|---|
| superuser `CREATE EXTENSION pgroonga` → 属主重跑 `0005` | `NOTICE: [0005] pgroonga 索引就绪:7 条` |
| 索引清单 | `pgroonga` 7 条 + `gin` 7 条 `*_trgm`，**并存**（降级索引刻意另起名，所以能先建后删、不停机切换） |
| `&@~` 查询 | 正常返回（不再 42883） |
| `0005` 幂等重跑 | 7 条 `already exists, skipping` + `索引就绪:7 条` |
| DROP 7 条 `*_trgm` 后 | `&@~` 仍正常；trgm 计数 0 / pgroonga 计数 7 |

**什么时候才能 DROP `*_trgm`**：不要与建 pgroonga 索引同一步做。顺序是
①`0005` 重跑完成、7 条 pgroonga 索引 `indisvalid=true` → ②BFF 切到 `&@~` 并**观察一个完整
流量周期**（两套索引并存，读路径可随时回切）→ ③监控里无 `42883` → ④才 DROP。
DROP 语句与判据见 `docs/dba-handoff.md` §3.4（那 7 条 DROP 应用账号自己就能做）。

### 角色与授权：DBA 面已压到 ~50 行（2026-07-27 更新）

**实测的权限现实**（四条通道全部走死，详见 `docs/dba-handoff.md` §1）：

```
rolname=user_dxzbdi  rolsuper=f  rolcreatedb=t  rolcreaterole=f
sudo -n -u postgres psql    → sudo: a password is required（无任何 NOPASSWD 条目）
peer 认证 -U postgres        → FATAL: Peer authentication failed（peer 开着，但 OS 用户不匹配）
pg_hba.conf                  → 文件 0640 postgres:postgres 读不到；pg_hba_file_rules 视图 permission denied
全库非 pg_* 角色只有 3 个     → postgres(唯一 superuser) / user_dxzbdi / user_dxzBDi，后两个都无特权
                                且 user_dxzbdi 不是任何角色的成员 ⇒ SET ROLE 也提不了权
```

**但本轮逐语句核过之后发现：真正需要特权的只有 `CREATE ROLE` / `COMMENT ON ROLE`。**
全部 `GRANT` / `REVOKE` / `ALTER DEFAULT PRIVILEGES` 只要求**对象属主**身份，
而 v2 的属主就是 `user_dxzbdi` 自己（`datdba` = 它、四个 schema 的 `nspowner` = 它、
78 表 38 函数属主 = 它；`public` 属 `pg_database_owner` 而它是其成员）。

于是把原来那份 456 行、整份标"需 DBA"的脚本拆成三个文件：

| 文件 | 内容 | 谁执行 | 进 apply.sh？ |
|---|---|---|---|
| `9000_roles_grants.sql.ADMIN` | 历史上的大而全版本，**保留作备选**（DBA 手上有 superuser 想一把梭时用） | DBA | 否（`.ADMIN` 后缀） |
| **`9001_create_roles.sql.ADMIN`** | **只有 5 条 `CREATE ROLE` + 5 条 `COMMENT`**，~50 行 | **DBA** | 否 |
| **`9002_grants.sql`** | 其余全部授权矩阵 + 强制自检 | 应用账号 | **是**（`[0-9]*.sql` 命中） |

收益：DBA 要审的代码里**一条 GRANT 都没有**；今后授权矩阵随 schema 演进而改，**不用再找 DBA**。

**`9002_grants.sql` 的两个关键设计**：

1. **角色不存在时跳过而不是失败。** 每段授权都用 `to_regrole('<role>') IS NULL` 守卫，
   缺角色只 `RAISE NOTICE` + 一条总账 `WARNING`，照常 `COMMIT`。
   这样它能安全地待在 `apply.sh` 常规序列里，DBA 建好角色后**重跑一次即补齐**。
   ⚠ 反过来：**"`apply.sh` 没报错"不等于授权生效。** 唯一判据是
   `[9002 §10] 权限边界自检全部通过（8 条负向 + 2 条正向）` 这行 NOTICE。
2. **第 10 节是强制自检**，角色齐全时任一边界不成立就 `RAISE EXCEPTION` 让迁移失败
   —— 把"权限即边界"从口头约定变成迁移失败条件。

**已经在真实 `scpper-v2` 上生效的部分**（不依赖角色）：`REVOKE ALL ON DATABASE ... FROM PUBLIC`、
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`、四个 schema 的
`REVOKE EXECUTE ON ALL FUNCTIONS FROM PUBLIC`、`ALTER DEFAULT PRIVILEGES` 的 PUBLIC 收回。
之后 `smoke_test.sql` **249/249 仍全绿**（确认收口没打断任何写路径），
`has_table_privilege('public','ingest.vote_event','INSERT')` = `f`，PUBLIC 对 `apply_*` 的 EXECUTE = 0。

> 副作用要知情：收回 PUBLIC 的 `CONNECT` 后，只有属主 `user_dxzbdi` 能连 `scpper-v2`；
> `user_dxzBDi`（5433 实例用的另一个账号）**连不上 v2 了**。这是设计意图，但如果有人拿它
> 做过临时排查，需要改用 `user_dxzbdi`。

**Phase 1 gate 的负向断言已经实证过**（一次性容器里建了三个 `LOGIN INHERIT` 临时账号，
11 条逐条撞墙，全部符合期望）：

```
t_bff  → INSERT ingest.vote_event          ERROR: 42501: permission denied for table vote_event   ✅
t_bff  → SELECT ingest.apply_vote_snapshot ERROR: permission denied for function                   ✅
t_ing  → 同一函数                          业务错「page_id 1 未注册」⇒ 权限已通                    ✅
t_ing  → INSERT ingest.vote_event          ERROR: permission denied（采集器只能经函数）            ✅
t_proj → UPDATE serve.page_current(Tier-1) ERROR: permission denied                                ✅
t_proj → DELETE serve.page_stats(Tier-2)   成功                                                    ✅
t_bff  → UPDATE app.page_metric_alert SET new_value      ERROR（列级拒绝）                         ✅
t_bff  → UPDATE app.page_metric_alert SET acknowledged_at 成功（列级放行）                          ✅
```

⇒ `smoke_test.sql` 一直缺位的 **T6.6 至此有了实证**。角色在生产落地后把这 11 条固化成
TS 测试即可（见后续 TODO）。

**不执行的后果，别当成可选优化**：v2 仍然能跑（所有对象归 `user_dxzbdi`，它有全权），
但会缺掉"权限即边界"这一层：应用层写错代码就能绕过 `apply_*` 直写 `ingest.vote_event`
（v1 fast-vote 直写聚合列致盲脏页检测正是这个形态的事故）、BFF 能写事实表、
追踪表"只 additive"没有强制手段、不可变触发器的 `migration_role` 例外没有承载体
（判据 `pg_has_role(session_user,'migration_role','MEMBER')` 恒 false）。
结论：不阻塞上线，但五重保证掉到四重，**建议在 Phase 1 gate 之前完成**
—— 因为 gate 本身就有一条依赖它。

---

## 冒烟验证结果（2026-07-27，PostgreSQL 17.10）

`migrations/smoke_test.sql`：**296 / 296 全部通过**（2026-07-27 第二轮新增 S8/S9 共 47 条）。整个文件包在一个事务里、末尾 `ROLLBACK`，
跑完库里零残留（实测所有表 `count(*) = 0`，只有 `ingest.fact_seq` 前进 —— 序列本就不回滚）。
在**全新库**与**已跑过一遍的库**上各跑一次都全绿（两者会走到不同的水位分支，见 S6）。

```
 节  | 用例 | 通过 | 失败        节  | 用例 | 通过 | 失败
-----+------+------+------      -----+------+------+------
 S1  |   22 |   22 |    0       S4★ |    2 |    2 |    0
 S2  |   78 |   78 |    0       S5  |   51 |   51 |    0
 S2★ |    4 |    4 |    0       S6  |    7 |    7 |    0
 S3  |   29 |   29 |    0       S6★ |    4 |    4 |    0
 S3★ |   11 |   11 |    0       S7  |    7 |    7 |    0
 S4  |   34 |   34 |    0       S8  |   12 |   12 |    0
                                S8★ |   13 |   13 |    0
                                S9  |    9 |    9 |    0
                                S9★ |   13 |   13 |    0
                               ------+------+------+------
                                总计 |  296 |  296 |    0
```

覆盖内容（★ = 本次任务点名要求的用例）：

- **S1 身份层** — `register_page` × 2 页、`ensure_user` × 3 用户（wikidot / wikidot / anon）。
  幂等性、`page_current` 同事务铸行、`created` 事件的 `exact`/`inferred`、
  R12（`username` 只补不覆盖 / 真实 unixName 另存 `wikidot_unix_name`）、
  6 个非法入参必须抛错、`wikidot_id` 回显不一致必须拒绝应用。
- **S2 CAS 转移矩阵** — `cur ∈ {无行, 0, +1, -1} × obs ∈ {0, +1, -1}` 共 12 格，
  逐格断言返回值 / 事件 `kind`+`(old,new)` / `vote_current.direction` /
  `page_current` 四列增量 / `vote_revoked` 非空（= T1.b 逐字例外 2 的回归）。
  另含 ±2 归一化 + quarantine 留痕、精度偏序（`day→observed` 前进、反向不退化、
  `bootstrap` rank=0 抢不走任何精度）。
- **S2★ 幻影 revoke 回归** — `cur = NULL ∧ direction = 0`：返回 `NULL`、该 (page,voter) 零事件、
  **全库 `vote_event` 总数不变**、不产生 `vote_current` 行。这是 syncer v1 那 54 万条
  `removed` 的原型；守卫写成 `cur IS DISTINCT FROM tgt` 就会在这里造出撤票。
- **S3 / S3★ 四重门控** — ④ checksum 不符（`Σsign=2` vs 谎报 `%%rating%%=99`）⇒
  `checksum_ok=false`、`absence_allowed=false`、`revoke_candidate` **零新增**、本页零 revoke 事件、
  `meta.page_scan` 留下 `checksum_ok=false / expected=99 / actual=2`，而单调 upsert 照做；
  ④b 不传 `claimed_rating` ⇒ 同样禁止 absence（不给"忘了传"留静默后门）；
  ⑤ 空快照 + `claimed_total=42` ⇒ `failed` 且一票未动；① `is_complete=false`；
  ② `claimed_total` 不符；③ `visible_kinds` 把 `anon` 挡在 diff 之外、传空数组直接抛错。
  四门全过 ⇒ 只写 `meta.revoke_candidate`（`gate_result` 留痕逐项结果）**不写事实**；
  同 run 重复快照不累加 `confirmations`、换 run 才累加；
  `promote_revoke_candidates` 转正成真 `revoke` 事件（`source='wikidot_absence'`）；
  "出现即正证据"——voter 重新出现时**不看门控**直接删候选；单页 absence 熔断（缺席 90%）。
- **S4 / S4★ 不可变触发器** — `UPDATE`/`DELETE`/`TRUNCATE` 事实表全部 `25006`，
  含**单独 TRUNCATE `vote_event_p0000` 分区**（验证逐分区补挂）；
  `revision` 列白名单（GUC 未开时拒、白名单外的列即使开了 GUC 也拒、已有非空 `type` 被改则拒）
  且**放行窗口在函数返回后已关闭**；SCD2 只放行"关区间"、已关闭区间不得重开；
  逃生舱 `bypass_guard` 开则放行、关则立即恢复拒绝；
  `serve.page_daily_stats.views` 降值/DELETE/TRUNCATE 全拒、递增放行；tick 表 append-only。
- **S5 其余 `apply_*`** — `page_meta`（tags 排序去重 ⇒ 零写入、`hidden_tags` 并入触发一次区间切换、
  改名走 SCD2 + `renamed` 事件、`claimed_rating` 绝不写 `page_current.rating`、
  selector 字面量残留整批拒绝）；`page_life`（幂等、`restored` 清 `deleted_at`、
  删除推断的 run 级门控四种拒绝路径、`crom` 属显式证据免门控）；
  `revision_batch`（待补行被认领回填仍 1 行、P0-8 漏传 perpage 判 `failed`）；
  `attribution_snapshot`（`is_complete=false` 不产生 removed、SUBMITTER 抑制的两个方向）；
  `forum_batch`（三表 upsert、`thread.page_id` 反解、未知 category/thread 进隔离、
  `text_plain` 剥标签兜底、重复 upsert 不被 NULL 覆盖）；
  `vote_history`（折叠取终态、终态 0 且无既有票 ⇒ 不造幻影 revoke、bootstrap 精度、
  重放幂等、名单缺人绝不 absence 推断、完整性不符只判 partial）；
  **批量 = 逐行等价性**（25 voter 混合目标态，两条路径的 `vote_current` /
  `page_current` 四列 / `vote_event` 多重集全等，且 `p_targets` 打乱顺序结果不变）。
- **S6 / S6★ 游标安全** — `safe_seq_watermark()` 的核心性质：水位**严格低于**本(未提交)事务
  分配的 seq，且 `= max(gate.seq_floor - 1, 0)`；`advance_projection_cursor` 传
  `9223372036854775000` 只推到水位；`projection_window` 非空 ⇔ 水位 > 游标；
  未登记的投影抛 `23503`；T7.5 的 MVCC 边界（同事务的 `ingest_gate` 行对他人不可见 ⇒
  表机制单独用是无效的，真正起作用的是 advisory lock 屏障）。
- **S7 全局不变式** — I1–I4（`page_current` 四列 = `vote_current` 逐页折叠）、
  I8 `revision_count`、I9 `attribution_count`、I10 每条 `vote_event` 的 `(kind,old,new)` 组合合法、
  I7 pending 候选与"已是撤票终态"不矛盾、`vote_event_pdefault` 恒空。

**冒烟做不到的三组已补齐**（原「尚未覆盖」项，见下「多连接 TS 测试」）：T7.1/T7.2 的**多会话**
乱序提交注入、T5.2 的 5,575 条大批与属性测试生成器、T6.6 的 `bff_role` 权限被拒（条件跳过 +
用现存无权角色做机制排演）。三个文件在 `tests/t{5,6,7}-*.test.ts`，实测 **98 通过 / 0 失败 / 6 跳过**。

新增两节（2026-07-27 第二轮，47 条）：

- **S8 / S8★ R10 熔断物理开关** — `freeze_writes` 落库四件套、重复冻结不累加 `freeze_count`
  且**不覆盖首次触发的 `breach_metric`**、`write_freeze_status().effective` 的总闸传导、
  **冻结期 `meta.record_page_scan` 照常写入**（"冻结写入不冻结采集"的可执行断言）、
  `note_freeze_skip` 留下 `write_frozen:<domain>` 证据、逃生舱 `scpper.freeze_bypass`、
  `release_writes` 后 `reason`/`breach_*` **保留**；
  以及 **9 条 PGF01 断言**：`vote` 冻结时 `apply_vote_observation` / `apply_vote_snapshot` 被拒
  而 `apply_revision_batch` / `apply_forum_batch` 照常（**域隔离**），总闸 `all` 时
  `apply_page_meta` / `apply_page_life` / `apply_attribution_snapshot` /
  `promote_revoke_candidates` / `ensure_user` / `put_content_blob` 全被拒；
  拼写守卫（未登记域名 `23503`、`p_domain='all'` `22023`、空理由 `22004`）；
  末尾断言异常路径后**无残留冻结**。
- **S9 / S9★ 证据链 + 投影登记 + 建模决策** — `record_page_scan(run=NULL)` 证据仍落库、
  合成 run 的 `source='synthetic'` / `status='running'` / `coverage_ratio IS NULL`
  （⇒ 删除推断门控必拒）/ 同会话复用同一合成 run / `scpper.require_run_id=on` 转硬失败；
  `scan_task` 与 `page_scan` 的新 kind 真的能写；27 个 Tier-2 投影登记齐、Tier-1 三表不登记、
  **`rebuild_from` 与 `COMMENT ON TABLE` 零漂移**；红链可入库且**红链变蓝只是原地填
  `to_page_id`**（主键不变、零搬迁）、`normalize_target_slug` 三种归一化、标签维度趋势可入库、
  `entity_key`/`entity_id` 不一致被 `23514` 拒（否则同一页可在榜上出现两次）。

### `checks/` —— 只读漂移断言（与冒烟分工不同）

| | `migrations/smoke_test.sql` | `checks/*.sql` |
|---|---|---|
| 测什么 | 写路径的**行为**对不对 | 落地后的**结构/登记/接线**有没有漂移 |
| 是否写库 | 写（末尾 `ROLLBACK`） | **纯只读**，可对生产库直接跑 |
| 跑法 | `./apply.sh --smoke` | `./checks/run_checks.sh` |

```bash
./checks/run_checks.sh --database-url "postgresql://.../scpper-v2"
# [checks] 0001_projection_cursor_drift.sql ... OK
# [checks] 0002_write_freeze_wiring.sql ... OK
```

- `0001_projection_cursor_drift.sql`（6 条）：注释必须以 `rebuild_from=` 开头 / 每张 Tier-2
  表都已登记 / 登记项不得指向不存在或 Tier-1 的表 / **`rebuild_from` 与注释逐字相等** /
  游标不超过 `fact_seq` / `event_domain='none'` 的游标应恒 0（仅告警）。
  **反向验证做过**：改一条 `COMMENT` → `[drift-4]` 红灯；新建一张带注释的 `serve.*` 表 →
  `[drift-2]` 红灯；新建一张无注释的 → `[drift-1]` 红灯；同一张新表让 `0007` 直接失败
  （`event_domain` 未声明）。
- `0002_write_freeze_wiring.sql`（6 条）：14 个写入函数**逐个**必须出现
  `assert_writes_allowed`（直接查 `pg_proc.prosrc`）/ 反向要求任何新增 `ingest.apply_*`
  必须登记进清单 / 传入的域名必须在 `write_freeze` 词表内（拼错会让熔断静默失效）/
  9 个域预置行齐 / 当前有域被冻结时在 CI 输出里刺眼告警。

**`checks/` 目录的完整内容**（整合期从两个同名目录合并而来，见「整合验证」）：

| 文件 | 谁跑 | 作用 |
|---|---|---|
| `run_checks.sh` | 随时 / CI | 按序跑本目录下的 `[0-9]*.sql`，任一条红灯即非零退出 |
| `0001_projection_cursor_drift.sql` | `run_checks.sh` | 投影登记漂移（6 条，只读） |
| `0002_write_freeze_wiring.sql` | `run_checks.sh` | R10 熔断接线（6 条，只读） |
| `embedding_smoke.sql` | 手工 / 改完 `0008` 后 | 语义检索域功能冒烟（E1–E13，末尾 `ROLLBACK`） |
| `load_v1_identity.sh` | Phase 2 回填前 | 把 v1 身份 id 单向 `COPY` 进暂存表（对 v1 只发 `SELECT` / `COPY TO STDOUT`） |
| `backfill_finalize.sql` | Phase 2 回填后 | 50 条收尾断言 + 15 条序列重置 + 留痕；不过即 `RAISE EXCEPTION` |

`run_checks.sh` 只扫 `[0-9]*.sql`，所以后三个不会被它误跑；它们各有各的前置条件与执行时机。

### R10 熔断演练（上线 gate 的可执行版本）

```sql
SELECT meta.freeze_writes('all', '演练:注入解析故障', 'drill', 'avg_votes_per_page');
SELECT ingest.apply_vote_snapshot(...);          -- 期望 SQLSTATE PGF01
SELECT meta.record_page_scan(<run>, <page>, 'votes', 'failed');  -- 期望成功（采集不冻结）
SELECT meta.release_writes('all', 'drill');
```

---

## 快速开始

```bash
cd syncer2
npm install
cp .env.example .env      # 至少填 SYNCER2_DATABASE_URL
npm run typecheck
npm run test:offline      # 不连库、不触网的那部分测试（HTTP 护栏 + sitemap 解析）
npm test                  # 全部测试（需要 scpper-v2 可连）

# 不连库、只跑网络侧与 diff（schema 还没落地时用这个）
npm run sitemap:delta:dry

# 正常一轮
npm run sitemap:delta
npm run sitemap:full
```

## CLI 契约

```
node --import tsx/esm src/cli/sitemap-scan.ts --mode <delta|full|threads|category|index> [选项]

  --dry-run             不连库、不写 meta.*、不推进快照
  --skip-tz-check       跳过时区回环自检（仅限本地调试，禁止用于调度器）
  --page-scan <policy>  none | changed | all（默认 delta=changed, full=all）
  --emit-entries <file> 把本轮条目导出为 NDJSON（供 sitemap 刷新周期实测用）
  --concurrency <n>     sitemap 并发请求数
```

- **stdout 只有最后一行 JSON 摘要**，调度器可直接 `JSON.parse`
- **所有日志走 stderr**（包括被劫持的第三方库 `console.*`）
- **失败以非零码退出**，交调度器重启；进程内不做顶层重试

成功摘要示例：

```json
{"ok":true,"mode":"delta","runId":41,"status":"ok","durationMs":1284,"bootstrap":false,
 "entries":10000,"uniqueSlugs":10000,"files":1,"usedFallback":false,
 "newSlugs":2,"advanced":17,"regressed":0,"unchanged":9981,
 "unresolvedSlugs":1,"absentEligible":false,"absent":0,"absenceCircuitTripped":false,
 "pageScansWritten":18,"tasksEnqueued":18,"slugResolution":"page_slug_history",
 "wireBytes":184320,"decodedBytes":1196032,
 "http":{"requests":2,"attempts":2,"retries":0,"statusBuckets":{"200":2},"breakerOpen":false}}
```

失败摘要：`{"ok":false,"mode":"...","status":"failed|aborted","error":"...","breaker":true|false}`
（`status:"aborted"` = 断路器主动停手，重启也不会好，需要人看；`"failed"` = 一般失败，可重启。）

## 调度

```cron
*/10 * * * *   cd /path/to/syncer2 && npm run -s sitemap:delta   >> /var/log/syncer2-delta.jsonl
17  */4 * * *  cd /path/to/syncer2 && npm run -s sitemap:full    >> /var/log/syncer2-full.jsonl
23  5  * * *   cd /path/to/syncer2 && npm run -s sitemap:threads >> /var/log/syncer2-threads.jsonl
```

日志文件本身就是一份 NDJSON 遥测流。**不要**用 PM2 的常驻模式跑这些命令——理由见 `src/README.md` §1。

---

## 采集层自动化测试（`tests/http.test.ts` / `parse.test.ts` / `db.test.ts` / `egress-identity.test.ts`）

```bash
npm test              # 全部 7 个测试文件（含 schema 侧的 T5/T6/T7 gate，需要 scpper-v2）
npm run test:offline  # 只跑 HTTP + 解析：不连库、不发一个外网请求（本地测试服）
npm run test:db       # 只跑时区回环（需要 scpper-v2）
npm run typecheck:tests
```

> **`npm test` 的当前基线：`tests 102 / pass 102 / fail 0`**（node:test 口径，约 30 s）。
> 内部 `Report` 口径另有 6 条 `skip`，全在 `t6-role-permission.test.ts`，等 `9001` 建角色后自动生效。
> 跑之前先 `cp .env.example .env` 并填 `SYNCER2_DATABASE_URL` —— 连不上库是**失败**而不是跳过（刻意如此）。

三组测试对应的是**采集层三道护栏**，都是把前几轮的手工验证固化下来的（2026-07-27，75 条断言组全绿）：

| 文件 | 断言组 | 钉住的失效模式 |
|---|---|---|
| `tests/http.test.ts` | 25 | 空/空白/带 CRLF 的 UA・Referer 在**构造期**就被 `HeaderContractError` 拒；**503/429 零重试**、连续到阈值熔断、**熔断后请求计数不再增长**（本地测试服计数证明"完全不触网"）；500 才重试到 `maxAttempts`；3xx 不跟随；连续传输重置单独熔断；gzip 解压正确且 `wireBytes`/`decodedBytes` 分别记账；**每请求恰好一条遥测**（成功/重试后成功/重试耗尽/立即失败/熔断五种结局） |
| `tests/parse.test.ts` | 31 | **空结果与解析失败必须可区分**：8 种坏输入（WAF/HTML 页、空响应、JSON 错误体、空 `urlset`、缺 `loc`、**被截断**…）全部 `throws`，**没有任何一条返回空数组**，且病因描述互不相同；站点根条目（无 slug）**计入 `parse_drop_rate`** 而不是静默丢弃；`loc` 格式整体变化时 drop_rate 飙到 1.0 可见 |
| `tests/egress-identity.test.ts` | 14 | TODO #12/#13/#14 的**判据本身**：`WIKIREQUEST.info` 抽取（`pageId` 抽不到 ⇒ 返回 `null`，`pageId=0` 也拒 —— 绝不铸假身份；`pageUnixName` **含 category 前缀**，这是身份守卫成立的前提）；slug→URL 时 `:` **不许**被百分号编码；AMC 响应 body 变形 ⇒ 解析出 0 条（探针据此判失败，而不是"通过但没数据"）；探针策略词表与按通道默认值；`wikidot_token7` 随机而非库里写死的 `123456`；出口 IP 形状校验挡掉 HTML 错误页与越界八位组；退避阶梯 1h/4h/24h/7d 并在 7d 收敛 |
| `tests/db.test.ts` | 19 | `assertTimezoneRoundTrip` 在正确写法下通过、幂等、不留临时表；**负对照**：重演 v1 `MainDbBridge` 的裸 `Date` 写法，断言它确实产生 **+8 小时**偏移、并在 analytics 二次换算下变成 **+16 小时跨日串日**；同一个裸 `Date` 写进 `timestamptz` 列反而是对的（病因是**列类型 × 参数类型的组合**）；`query()` 在碰到驱动之前就拒掉裸 `Date`（假 db 的 `query` 调用次数 = 0） |

设计取向说明：

- **不做"连不上库就 skip"**。静默跳过的守卫等于没有守卫，这与解析层"空结果不许当成合法结果"是同一条原则。`db.test.ts` 另有一道硬关卡：连接串库名不是 `scpper-v2` 就直接失败，**主库 `scpper-cn` 连 TEMP 表都不许建**。
- **负对照是刻意的**：一道守卫如果从没见过它要防的失效模式，就无法证明它还瞄得准。将来若有人把 `toPgTimestamptz` 去掉、把列改回 `timestamp without time zone`、或注释掉 `assertNoRawDates`，这几条会立刻变红且直接指出病因。
- **变异验证**（确认测试真的会红，不是摆设）：临时去掉 `parse.ts` 的闭合标签断言 + 让 `normalize` 静默丢无 slug 条目 → parse 6 条失败；把 503 改成可重试 → http 5 条失败；去掉 `query()` 里的 `assertNoRawDates` → db 2 条失败。还原后 75/75 全绿。
- fixture 出处：`tests/fixtures/*.real.xml` 是 2026-07-27 实测响应（副本，因为 `experiments/data/` 是 gitignore 的）；`*.reconstructed.xml` 按实测结构重建（当时未落盘索引响应本体）；`*.synthetic.xml` 是人造边缘形态，文件内逐条注明测什么。

## 多连接 TS 测试（冒烟做不到的三组，2026-07-27）

```bash
npm run test:gates    # 三组一起，串行（--test-concurrency=1）
npm run test:t7       # 多会话游标安全
npm run test:t5       # 5,575 票大批 + 属性生成器
npm run test:t6       # 权限矩阵（角色未落地则条件跳过）
```

`migrations/smoke_test.sql` 是**单文件单事务**的 psql 脚本，结构上做不到三件事：开两个连接、
在测试侧生成随机数据并报告 seed、以 `SET ROLE` 切身份。这三组因此必须落在 TS 侧
（`node:test` + `tsx`，零新依赖）。实测 **98 通过 / 0 失败 / 6 跳过**：

| 文件 | 断言 | 钉住的失效模式 |
|---|---|---|
| `tests/t7-cursor-safety.test.ts` | 32 | **静默漏投影**。写者 A 取到 seq 后不提交、B 后取先提交 ⇒ `safe_seq_watermark()` 必须返回 NULL 或 < A 的 seq，`projection_window()` 必须给空窗口。同一断言组里带**反例基线**：此刻 `fact_seq.last_value` 已越过 A 的 seq（朴素水位会漏投），且**只用 `min(seq_floor)` 的表机制也已越过**（T7.5 的 MVCC 边界，防止有人"优化"掉屏障锁）。四写者交错提交 8 轮后断言每条 `vote_event` 被**恰好消费一次**（0 漏 / 0 重复）；回滚写者烧掉的 seq 不让游标卡住；拿不到水位时 `advance_projection_cursor` 抛 `55006` 且游标一动不动 |
| `tests/t5-vote-batch.test.ts` | 49 | **批量与逐行分歧**。5,575 票（实测最大页 scp-cn-2000 的真实票数）同时走 `apply_vote_snapshot`（集合化）与 `apply_vote_observation` 逐行 N 次，比**三个口径**：事件序列逐位 + 事件多重集对称差 + `vote_current` 全表 + `page_current` 四列。初始快照 / 30% 转移的第二轮 / 重放各比一次。属性生成器 60 轮随机快照（seed 可复现），覆盖 `direction=±2`、同 voter 多记录、混合 kind（wikidot/anon/guest/synthetic）、空快照、`is_complete=false`、`claimed_total` 不符、checksum 不符、`policy=forbidden`，逐轮断言 9 条不变式（I1–I4 折叠、事件链 `old = prev.new`、首事件必为 `vote`、幻影 revoke 零条、`|direction|≤1`、门控③ 候选表不含非可见 kind、事件数单调、重放幂等、`pdefault` 恒空） |
| `tests/t6-role-permission.test.ts` | 17 + 6 跳过 | **"权限即边界"缺位**。分四层：① PUBLIC 对 8 张事实表零 DML、对任何 `SECURITY DEFINER` 函数零 EXECUTE（现在就全绿）；② 角色存在则跑目录级 `has_table_privilege` 矩阵（**不需要成员资格**，DBA 一执行 9000 就自动生效）；③ 有成员资格则 `SET ROLE bff_role` 真 INSERT 一次要 `42501`；④ **机制自检**：用 `pg_database_owner`（现存、对 ingest/serve 零权限、当前账号天然是其成员）把 ③ 的路径完整排演一遍 —— 表级 `42501` 实测成立，临时 GRANT 随事务 ROLLBACK 完全消失 |

设计取向说明：

- **跳过 ≠ 通过**。T6.6 的 5 条目录级断言 + 1 条行为级断言在角色落地前必然跳过，报告里 skip 独立成列、每条打印补救指令（执行 `9000_roles_grants.sql.ADMIN` + 重跑 0006 第 8 节）。第 ④ 层的存在就是因为"跳过的断言连自己写对了都证明不了"。
- **数据策略按测试形态分两种**：T5 是单会话 ⇒ 全程一个事务 + `ROLLBACK`，零残留（只有序列前进，序列本就不回滚，与冒烟同理）；T7 的被测对象**就是跨会话可见性**，回滚在语义上用不了 ⇒ 真提交 + 末尾按专属 id 段删除，并有一条"零残留"正向断言。删事实表要靠 `SET LOCAL scpper.bypass_guard='on'`（0006 第 3 节的迁移逃生舱），于是清理本身顺带成了逃生舱的回归。
- **专属 id 段**：`page.wikidot_id ∈ [970000000, 979999999]`、`user.wikidot_id ∈ [980000000, 989999999]`、非 wikidot 用户 `anon_key LIKE 'ts2test:%'`、`ingest_run.source = 'test_syncer2'`、`projection_cursor.projection LIKE 'test_%'`。与冒烟的 990001+ 段不重叠，两套可并存。连接串另有受保护库黑名单（含 URL 解码），指到 `scpper-cn` 直接拒绝启动。
- **变异验证**（确认不变式真的会红）：`UPDATE serve.page_current SET rating = rating + 7`（模拟 v1 fast-vote 直写聚合列）⇒ I1–I4 检出 1 页；直插一条 `old_direction` 与前一事件 `new_direction` 不符的 `revote` + 一条以 `revote` 开头的事件链 ⇒ 链断裂检出 2 条、首事件检出 1 条。三条负对照都在事务里跑完 `ROLLBACK`。
- **属性测试换种子复跑**：`SYNCER2_TEST_SEED=1 / 987654321 / 424242` 各跑一遍（`SYNCER2_TEST_ITERATIONS=45`），49/49 全绿且形态覆盖表每格非零 —— 不是某一个种子碰巧过。
- **顺带查实的一件事**：`apply_*` 只在入口调 `meta.ingest_gate_open()`，**从不调 `ingest_gate_close()`**（0006 里它被标为"可选出口"）。所以 gate 行不是"同事务 INSERT+DELETE"，而是提交后留在表里（`txid_status = 'committed'`，不影响水位正确性，因为水位只统计 `in progress` 的行）。**运维含义：`meta.ingest_gate` 会随摄入量单调增长，必须有周期任务调 `meta.ingest_gate_sweep()`**（见「后续 TODO」）。T7.1 里有一条断言把这个事实钉住。

## sitemap 通道实测账（2026-07-27，scp-wiki-cn）

> ⚠ **本节有两条结论在 2026-07-27 的第二轮实测里被推翻了**（原表述"近似按 lastmod 降序"
> 与"sitemap 做发现层"）。下表是修订后的版本，完整证据见
> `experiments/sitemap-probe.md`，架构后果见 `../docs/data-model-v2-addendum-2026-07-27.md` §1。

| 项 | 结果 |
|---|---|
| 索引 | `sitemap.xml` → 4 × `sitemap_page_N` + 9 × `sitemap_thread_N` + 1 × `sitemap_category_1` |
| 页面枚举 | **35,983** 个唯一 slug（10,000 + 10,000 + 10,000 + 5,983） |
| `sitemap_page_1` | 1.14 MB → **gzip 180 KB / 1.2–6.3 s / 10,000 条** |
| 全量 4 文件 | gzip ≈ 620 KB / ≈ 5–20 s |
| `lastmod` | **=== ListPages `%%updated_at%%`，逐秒完全相等（5/5）**，UTC，无时区歧义 |
| **刷新机制** | **整文件、惰性、按 TTL 重生成，不是 per-page 增量。** 同一份 `sitemap_page_1` 在 **18 次抓取 / 57.2 分钟**内 md5 完全相同；**已抓到换版瞬间**（09:37:41 旧 → 09:41:43 新），新版最大 `lastmod` 只比请求早 **16 秒** ⇒ 重算实时，**滞后 100% 来自 TTL**。**TTL ∈ [59.6, 73.8] 分钟，几乎确定是 60 分钟整**；滞后期望 ≈30 min、最坏 ≈60 min |
| **排序（原结论已推翻）** | **不是 `lastmod` 降序，差得很远**：`page_1` 内 **39.1%（3,907/9,999）** 降序违例，`lastmod` 最老到 **2014-02-24**，与严格降序的名次位移中位数 **2,666**。真实排序键是**"最后活动 = 编辑 ∨ 投票 ∨ 评论"**（K 十分位单调 + 98.2% 违例可由投票/评论解释）。⇒ **禁止 lastmod 阈值早停，必须整文件解析**。覆盖下界改用 `B = max(lastmod over page_2..4)` = 2026-04-05 04:18:29，经 ListPages 独立交叉验证零漏（4,269 = 4,269） |
| **新页延迟（原结论已推翻）** | `scp-743-jp` 创建 08:57:12 → 创建后 2.4 min 的**全量 4 文件里不存在** → **44.5 分钟后才首次出现**；而 ListPages **13.5 分钟内**就报出了它。⇒ **sitemap 不能做十分钟级新页发现** |
| 缓存 | `no-cache, must-revalidate`，**无 ETag / 无 Last-Modified**，`x-wikidot-static-cache` **恒 MISS** → 条件 GET 与缓存旁路都不可用，滞后压不下去 |
| thread 族 | 9 文件 = **86,900** 个唯一 thread id，**无 lastmod**，只给存在性；对库的严格子集（`sitemap∖库`=0），对 `882986 翻译预定区(归档)` 与 `2020429 垃圾桶` **100% 失明** |
| category 族 | **14 个**（此前"15 个"把站点根 URL 数进去了）；库内 16，差的正是上面那两个隐藏分类 |
| 枚举域 | **完全算平**：`35983 = 36173 − deleted:66 − forum:6 − adult:133 − wanderers-adult:5 + 「_ 前缀隐藏页」20`，误差 0。注意 `old:`（554 归档页）**在** sitemap 里，只有 `deleted:` 不在 |
| 枚举稳定性 | 两次全量快照相隔 78 分钟：唯一 slug 数 35,983 = 35,983，新增 0 / 消失 0，覆盖下界 `B` 完全相同 ⇒ **可放心作 absence 基准** |
| 对比 | 全站枚举：sitemap 4 请求 / 620 KB / 5 s **vs** ListPages 145 请求 / 6 MB / 430 s |

**sitemap 在架构里的正确位置（修订后）**：**枚举完整性 / absence 基准 / 第二独立源**，
不是发现层。它的价值是**"全、便宜、独立、对修订洪水结构性免疫"**，不是"快"。
发现层交给 `ListPages order=updated_at desc` 与 `order=created_at desc`（各 1 请求 @3 min，
滞后 48 s – >13 min）。

**四条必须遵守的硬约束**（写错了表现为幻影删除或漏检，不是性能问题）：

1. **整文件解析，禁止 lastmod 早停**（排序不可信）。
2. **md5 短路**：与上轮相同直接跳过解析与 diff；且**不要因为"这一轮没变化"就触发任何
   absence 逻辑**（TTL 内 18 次抓取字节完全相同）。
3. **absence 判删的"连续 ≥2 轮缺席"，轮间隔必须 > 1 个 TTL（建议 ≥2 h）** ——
   否则两轮读到的是同一份文件，等于只看了一轮。
4. **absence 必须硬排除 `deleted:` / `forum:` / `adult:` / `wanderers-adult:` 四个分类**
   （那 138 个 adult 页在 sitemap 里永远缺席，会被连续误判为删除），
   并建议在枚举归一层过滤 `^(?:[^:]+:)?_` 的 slug（否则每轮报 20 条假差异）。

**边界**：sitemap 没有任何元数据（无 rating / rating_votes / tags / comments），投票与评分信号
仍必须靠 ListPages；且**只有 `lastmod` 没有 `created_at`** ⇒ **改名与"删除+新建"在 sitemap
视角下不可区分**，必须用 `%%page_id%%` 在 pageId 层面复核收口。

---

## 环境变量

见 `.env.example`。三个不能忽略的：

- `SYNCER2_USER_AGENT` — **不能为空**。实测空 UA → WAF 返回 HTTP 503 空体。
- `SYNCER2_REFERER` — **不能为空**。实测 AMC POST 缺 Referer → TCP 连接重置（0/15 成功）。
  值任意（边缘只校验存在性），但缺失即死。

  这两个变量的空值语义特殊：**不设置**会用默认值，**设置成空串**则直接报错拒绝启动。
  静默回落会让 `assertHeaders()` 永远无法触发，而它保护的恰恰是"头被弄丢"这个场景。
  （与之相反，`SYNCER2_HTTP_PROXY` 留空是合法的，意为"不走代理"。）
- `SYNCER2_DATABASE_URL` — v2 独立库。**syncer2 不持有主库 `scpper-cn` 的连接串**，
  并行期主库是只读的，采集层根本不该有能力碰它。

## 依赖说明

- **不引 XML 解析库**：sitemap 是结构极窄的机器生成 XML，正则解析面更小，
  也省掉 XXE / entity-expansion 那一堆需要显式关掉的开关。代价由 `parse.ts` 的三道结构断言兜住。
- **`@ukwhatn/wikidot` 已列入依赖但本次交付未使用**：sitemap 通道是纯 GET，不经 AMC。
  后续的 ListPages / WhoRatedPageModule 采集会用到它（库默认带 `Referer: https://www.wikidot.com/`，
  所以**库路径是安全的**；手搓请求必须自己带 Referer）。
- **迁移不依赖任何扩展**。`0001`–`0004` / `0006` 零扩展依赖（`pgcrypto` 的依赖已在整合中
  去掉，改用内建 `sha256(bytea)`）；只有 `0005` 会尝试建扩展，且失败不阻断。

---

## 整合期对迁移文件做的修改（2026-07-27）

这四处是**在真实新库上试跑才暴露出来的**，不是审阅出来的 —— 前三处都属于
「`CREATE` 成功但运行期必炸」，plpgsql 函数体的 SQL 只在首次执行时解析，
所以不实际跑一遍数据就看不见。

1. **`meta.revoke_candidate` 两份定义打架**（`0003` vs `0006`，**唯一一个让迁移直接失败的**）。
   `0003` 初稿是 `id bigserial` 主键 + `WHERE status='pending'` 的部分唯一索引，列名
   `seen_count` / `run_id` / `resolved_event_seq`，`observed_at NOT NULL` 无默认；
   而 `0006` 的函数用 `ON CONFLICT (page_id, voter_id) DO UPDATE SET confirmations = …`，
   读 `last_run_id` / `held_reason` / `promoted_seq`。0003 先跑 ⇒ 0006 的 `CREATE` 变 no-op ⇒
   `ERROR: column "confirmations" does not exist`。
   已按**可执行代码**定稿 0003 的形状（复合主键 + 统一列名 + `observed_at` 给默认值），
   0006 的兜底 DDL 逐列对齐，`status` 词表统一为 `pending|promoted|dismissed|held`
   （初稿的 `confirmed→promoted`、`rejected→dismissed`、`expired→dismissed`）。
   顺手让 `apply_vote_snapshot` 真的去填 `gate_result` / `gate_passed` / `observed_at`，
   否则那三列是永远为空的死列。
2. **函数级 `SET scpper.revision_backfill = 'on'` 在 PG15+ 建不出来**。把未注册前缀的自定义
   GUC 写进 `proconfig` 需要该参数的 `SET` 权限，而 `GRANT SET ON PARAMETER` 本身要 superuser
   （实测 `42501: permission denied to set parameter`，且自助 GRANT 也被拒）。
   改成 `apply_revision_batch` 内部用 `set_config(..., is_local := true)` 在**回填那一条
   UPDATE 前后开合**，并显式还原 —— 比原写法更严（放行窗口从"整个函数体"收窄到一条语句），
   且异常路径由子事务回滚兜住，不可能留下敞开的放行位。冒烟里有专项断言。
3. **`put_content_blob` 调 pgcrypto 的 `digest()` 必然 42883**。该函数 `SET search_path =
   pg_catalog, pg_temp`，而 pgcrypto 装在 `public` ⇒ unqualified `digest` 永远解析不到。
   顺带还有个口径问题：`digest(text,…)` 摘要的是服务器编码字节，与 TS 侧
   `createHash('sha256').update(s,'utf8')` 只在库编码恰好是 UTF8 时一致 —— 而
   `put_content_blob_sha()` 变体正是让 TS 算 sha 传进来的，两条路必须同源。
   改用内建 `sha256(convert_to(…, 'UTF8'))`：零扩展依赖，两个变体逐字节同源（已断言）。
4. **`safe_seq_watermark()` 在全新库上返回 −1**。虚拟库的 `fact_seq` 还没被用过 ⇒
   `ingest_gate_open` 登记的 `seq_floor = 0` ⇒ `LEAST(...) = -1`。负值本身无害（下游都是
   `seq <= watermark`，而 seq 从 1 起），但会让"水位"这个量在日志/监控里出现物理上不存在的
   取值。已下钳到 0（语义恰好正确：「还没有任何 seq 是安全的」）。
   这条只有在**真正全新的库**上才看得到 —— 老库因序列已被推进而永远撞不到。

另外修正了若干跨文件指向错误的文件名注释（`0003_functions_triggers.sql` → `0006_functions.sql`、
`0900_roles_admin.sql` / `0009_roles_grants.admin.sql` → `9000_roles_grants.sql.ADMIN`、
`0001_core.sql` → `0001_ingest.sql`、`0003_app`/`0004_meta` 顺序写反）。

### 第二轮:为什么这次**回改了 `0006_functions.sql`**（2026-07-27）

本 README 的纪律是"改结构一律新开 `0007+`"。这一轮有三处改在 `0006` 里面，判据是
**"结构"与"函数体"不同**：`CREATE TABLE IF NOT EXISTS` 重跑不收敛（所以结构只能靠新 ALTER），
而 `CREATE OR REPLACE FUNCTION` 重跑**逐字收敛**——文件内容就是最终形状，不存在分叉窗口。
把 14 个函数的入口检查塞进一个 `0007+` 文件，代价是把几百行函数体复制一遍，
那才真的会产生两份互相漂移的定义（`meta.revoke_candidate` 就是这么炸的）。

1. `meta.record_page_scan` 的 **`run_id IS NULL` 静默丢证据**（属 bug 修复，见 TODO #6b）；
2. 14 个写入型函数入口各加一行 `PERFORM meta.assert_writes_allowed('<域>')`（R10 熔断接线）；
3. `apply_forum_batch` 补 `kind='forum'` 的页级扫描证据（词表里有、此前无人写）。

新增结构则严格走新文件：`0007_meta_gaps.sql`（词表 / `write_freeze` / 投影登记）、
`0009_serve_modeling_decisions.sql`（红链 / 标签维度趋势）。

⚠ 编号撞车（**已在整合期解决**）：该文件原名 `0008_serve_modeling_decisions.sql`，与并行任务的
`0008_serve_embedding.sql` 同号。两者互不依赖、`apply.sh` 的 `LC_ALL=C sort` 顺序稳定
（`embedding` < `modeling`），实测双向都能跑通 —— 但"能跑"来自字母序这个偶然事实，
换个文件名就翻盘。整合时已改号为 `0009_`。下一个新文件从 **`0013`** 起（0007–0012 已用满）。

⚠ 与 `0008_serve_embedding.sql` 的一处**口径统一**：`meta.projection_cursor.rebuild_from`
存 `COMMENT ON TABLE` 的**整条原文**（含 `rebuild_from=` 前缀），不做截断。
本轮初版存的是去前缀后的表达式，而并行任务用 `obj_description()` 原样入库且刻意
`ON CONFLICT DO NOTHING` —— 两种口径并存会让同一列的形状**取决于迁移执行顺序**
（0007 先跑就覆盖成去前缀版，0008 又不改回来）。已统一为整条原文：与任务原文
"与 `COMMENT ON TABLE` 逐字一致"字面一致，且漂移断言退化成一个普通等号。

---

## 当前完成度

> 最后一次全量校验：**2026-07-27 整合验证**——`DROP DATABASE` → 从零 `apply.sh` → 幂等重跑
> → 冒烟 → checks → 全部 TS 测试 → 采集层端到端，全绿。明细见下节「整合验证」。

| 交付项 | 状态 |
|---|---|
| 四 schema 完整 DDL（`ingest`/`serve`/`meta`/`app`，**88 表 + 1 视图**） | ✅ 从零重建实测通过，幂等重跑零错误 |
| 10 个 `apply_*` 转移函数 + 不可变触发器（合计 46 个函数） | ✅ 已落地，296 个冒烟断言全绿 |
| 迁移执行器 `apply.sh` | ✅ 顺序执行 / 遇错报文件+行号 / 受保护库黑名单 |
| 冒烟脚本 `smoke_test.sql` | ✅ 296/296，`ROLLBACK` 不留数据；空库与有数据的库上各跑过 |
| 只读漂移断言 `checks/` | ✅ `run_checks.sh` 两条全过（Tier-2 31 表 / 31 行登记；14 个写入函数全接熔断） |
| sitemap 采集层原型 | ✅ 五种模式（index/delta/full/category/threads）+ `resolve-pages` 端到端实跑 |
| sitemap 刷新周期实测 | ✅ TTL ≈ 60 min；**并据此推翻了"sitemap 做发现层"的原设计**（见 `experiments/sitemap-probe.md` + `../docs/data-model-v2-addendum-2026-07-27.md` §1） |
| 设计文档修订附录 | ✅ `../docs/data-model-v2-addendum-2026-07-27.md`（R1–R15 落地状态 / 六个 blocker / 唯一常驻源决策的理由与代价 / 11 条悬空决策） |
| 五角色 + 授权矩阵 | 🔶 **授权脚本已写完并验证通过，只等 DBA 跑 5 条 `CREATE ROLE`**。DBA 面已从 456 行压到 ~50 行（`9001`）；其余 `9002_grants.sql` 应用账号自己能跑，已在同版本容器上端到端验证（含 11 条权限边界实测）。交接单：`docs/dba-handoff.md` |
| pgroonga 全文索引 | 🔶 生产仍是 pg_trgm 降级态，但**完整切换路径已在同版本容器（PG 17.10 + pgroonga 4.0.6）演练通过**：装扩展 → 重跑 0005 得 7 条 pgroonga 索引 → `&@~` 可用 → DROP 7 条 `*_trgm` 后仍可用。只等 DBA 一条 `CREATE EXTENSION` |
| 冒烟做不到的三组（T5.2 / T6.6 / T7.1-7.2） | ✅ `tests/t{5,6,7}-*.test.ts`，**98 通过 / 0 失败 / 6 跳过**（跳过的 6 条等 `9001` 建角色后自动生效），`npm run test:gates` |
| 采集层自动化测试（HTTP 护栏 / 解析红线 / 时区 / 出口归因） | ✅ `tests/{http,parse,db,egress-identity}.test.ts`；`npm test` 全量 **102 通过 / 0 失败** |
| 语义检索域归属 + embedding 重算决策 | ✅ `docs/embedding-migration.md` + `0008_serve_embedding.sql` + `checks/embedding_smoke.sql`（11 通过 / 2 待 pgvector） |
| 采集队列与新页消化链路 | ✅ `0012_collector_queues.sql` + `src/store/queues.ts` + `src/cli/resolve-pages.ts`，端到端实跑（含冷启动闸拦截） |
| Tier-2 投影 projector | ⛔ 未开始（表已建；`meta.projection_cursor` **31 行登记已完成**，见 `0007` §3 + `0008` §8 —— 前置条件已就绪） |
| Phase 2 v1→v2 回填 | ⛔ 回填本体未开始；**收尾 gate 已就绪并端到端演练过**（47,861 页 + 37,455 用户搬进独立测试库 `scpper-v2-gatetest`，gate 50/50 全绿；见下「Phase 2 回填收尾 gate」） |
| Phase 2 回填收尾 gate | ✅ `0100_backfill_gate.sql` + `checks/backfill_finalize.sql` + `checks/load_v1_identity.sh`，正反两条路径各实测（含 A2.1 抓出 25 个被合并的 guest 身份） |
| Prisma multiSchema 映射 | ✅ `prisma/schema.prisma`（独立文件，84 model / 4 schema），`validate` + `generate` 通过；7 条降级说明写在文件头 |

---

## 整合验证（2026-07-27）

六个并行任务各自在同一个 worktree、同一个 `scpper-v2` 上改迁移与代码。整合这一轮做了两件事：
**先解掉跨任务冲突，再把库整个推倒重建一次，证明"合起来仍然能跑"**。

### 解掉的三处跨任务冲突

| 冲突 | 处置 |
|---|---|
| **迁移编号撞车**：`0008_serve_embedding.sql` 与 `0008_serve_modeling_decisions.sql` 同号 | 后者改号为 **`0009_serve_modeling_decisions.sql`**（含文件内 9 处自引用、`0006` 与 `0008` 的顺序注释、README 三处）。两者本就互不依赖，同号时靠 `LC_ALL=C sort` 的字母序决定先后——能跑通，但那是**运气而非契约** |
| **两个同名 `checks/` 目录**：`syncer2/checks/`（只读断言）与 `syncer2/migrations/checks/`（回填 gate + embedding 冒烟） | 合并为**唯一的 `syncer2/checks/`**。顺带修好了一批本来就写错的相对路径——那几个文件头里的用法示例写的就是 `psql -f checks/backfill_finalize.sql`（从 `syncer2/` 根执行的形状），合并后它们才第一次成立。`run_checks.sh` 只扫 `[0-9]*.sql`，所以 `backfill_finalize.sql` / `embedding_smoke.sql` / `load_v1_identity.sh` 进来不会被它误跑 |
| **`meta.write_freeze` 的表级授权无人认领**：`0007` 只授了函数 `EXECUTE`，而 `9002_grants.sql` 的 ingestor 清单是**显式枚举**的、不会自动吸收后建的表 | 在 `9002` §4 补 `GRANT SELECT ON meta.write_freeze TO ingestor_role`（只读——`freeze_writes` / `release_writes` 是 `SECURITY DEFINER` 且各带守卫，采集器有权查、无权自行跳闸）。同时写明 `meta.pending_page` / `meta.forum_scan_task` 的 DML 授权**由 `0012` 自己给**，本文件不重复枚举，且 `9002` 对 `meta` 不做任何 `REVOKE`（否则会把 `0012` 的授权抹掉——它排在 `0012` 之后） |

另外核对无冲突的三处：跨文件**没有**重复创建同一对象（唯一的重复是 `0006` 对 6 张
`meta` 表的 `CREATE TABLE IF NOT EXISTS` 兜底，这是文件里写明的有意设计）；三个任务各自新增的
`tests/` 文件互不 import、`helpers/` 只被 T5/T6/T7 用；`src/store/meta.ts` 的两个 TS 联合类型与
`0007` 的 CHECK 词表**逐值相等**（`page_scan.kind` 8 项、`scan_task.kind` 11 项，已用 SQL 对过）。

### 从零重建的实测结果

| 步骤 | 结果 |
|---|---|
| `DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE` | 空库，0 个业务 schema |
| `apply.sh` 第一遍（12 个文件） | **全部 ✓，零 ERROR**。`0007` 正确打印「前向声明(表尚未创建,本轮不登记):{chunk_embedding,embedding_model,page_semantic,text_chunk,text_chunker}」并登记 27 个，随后 `0008` 登记自己的 4 个 ⇒ 31 |
| `apply.sh` 第二遍（幂等） | **全部 ✓，零 ERROR**；非 `already exists` 的输出只有降级/跳过类 NOTICE。`0007` 这次直接登记 31 个（前向声明只剩 `chunk_embedding`），`0100` 打印「已是 integer 域，跳过」 |
| `smoke_test.sql` | **296 / 296 全绿**，15 个分节零失败，末尾 `ROLLBACK` |
| `checks/run_checks.sh` | 两条全过：`Tier-2 表 31 张,登记 31 行,rebuild_from 逐字一致,游标自洽` / `14 个写入函数全部接了 R10 熔断开关,域词表自洽,当前冻结域 0` |
| `checks/embedding_smoke.sql` | 11 通过 / 2 跳过（E10/E11 是 halfvec 类型本身，等 pgvector） |
| `npx tsc --noEmit` + `tsc -p tsconfig.tests.json` | 均 exit 0 |
| `npm test`（7 个测试文件） | **tests 102 / pass 102 / fail 0**；内部 Report：T5 49/49、T6 17 通过 + 6 跳过（等角色）、T7 32/32 |
| `npm run prisma:check` | `valid 🚀` + `Generated Prisma Client`；自检「model 数 = 非分区表数 = 84」「分区子表未混入」「无丑关系名」 |
| 采集层端到端 | 见下表 |
| 收尾复查 | 测试专属 id 段（page `97xxxxxxx` / user `98xxxxxxx` / `source='test_syncer2'` / `projection_cursor test_%`）**全部 0 行**；`meta.write_freeze` 9 域全 `frozen=false`；`source='synthetic'` 的 run 0 条 |

之后**又在有真实数据的库上复跑了一遍冒烟与 `npm test`**，同样 296/296 与 102/102 ——
排除掉"只在空库上成立"的那类假绿。

### 采集层端到端（本轮共 **33 次** wikidot 请求，全部 HTTP 200，零重试零熔断）

| 动作 | 结果 |
|---|---|
| `--mode index --amc-probe require --proxy-check require` | 索引 14 个子文件（page 4 / thread 9 / category 1）；**AMC POST 探针通过**（`attempts:1, categories:42`）；代理健康 require 通过；`assertHeaders` 与 `assertTimezoneRoundTrip` 两道启动自检均通过 |
| `--mode delta`（默认 `--page-scan changed`） | 10,001 条 → 10,000 唯一 slug，与上轮快照 diff：new/advanced/regressed 全 0 ⇒ 0 入队。**这正是 TTL≈60min 的可观测形态**（同一份 `page_1` 在一个 TTL 内不变） |
| `--mode full` | 4 个文件、35,987 条 → **35,983 唯一 slug**；`absentEligible=false`（空库无覆盖率证据，删除推断被门控挡住 ✅）；`pending_page` 入队 5,000 条并**按单轮上限截断**（告警已打，说明 sitemap 是全量快照、下轮重报不丢） |
| `--mode category` | 14 个 numeric id 全部入 `meta.forum_scan_task` |
| `--mode threads` | 9 个文件、**86,903** 个 thread id 全部入队（合计 `forum_scan_task` 86,917 行） |
| `resolve-pages`（不加 `--force-cold-start`） | **冷启动闸按预期拦截**：`pending 5000 > 阈值 2000` ⇒ `status='aborted'`、退出码 1、理由落进 `ingest_run.stats` |
| `resolve-pages --force-cold-start --limit 5` | 5/5 resolved，10 个 `scan_task`（`meta` + `new_page_highfreq`）；库内核对 `ingest.page` = `page_slug_history`(当前) = `serve.page_current` = `page_life_event(created)` = **5** —— `register_page` 承诺的"同事务四件事"实测成立 |
| 再跑一轮 `--mode delta --page-scan all` | `pageScansWritten=3` ⇒ **`meta.record_page_scan` 的真实链路打通**（此前两轮为 0，是因为已注册的 5 页当时都不在 `page_1` 切片里；先把 3 个 `page_1` 内的 slug 解析出来再跑，就写进去了） |
| `meta.ingest_run.exit_ip_stats` | 7 个 run **全部有值**：`byIp`（池构成采样）+ `byNode`（mihomo `chains[0]` 的按连接真值，实测拿到`🇭🇰 香港 9929` / `🇯🇵 東京 CN2` 等）+ `probe` 计数（每轮只探 1 次，不是每请求都探） |

回填 gate 也复验了两条：`gate:backfill:dry` 与 `gate:backfill` 都在 **A0.3** fail-fast
（`meta.v1_identity_load` 缺载入记录）并以**退出码 3** 结束 —— 即"暂存表为空时一一对应断言真空通过"
这个安慰剂形态确实被堵住；`checks/load_v1_identity.sh --dry-run` 对 v1 只发 `SELECT count(*)` /
`COPY … TO STDOUT`，实测 page 47,862 / user 37,456 / gacha 36,957，目标库零写入。

### 整合期没做的事（明确列出，别当成已完成）

- **`9001_create_roles.sql.ADMIN` 仍未执行**（需 CREATEROLE）。因此 `0006` §8 / `0007` §4 /
  `0012` §3 / `9002` §2–§7 的 GRANT 段全部走"角色不存在 ⇒ 跳过"分支，`9002` §10 的强制自检
  也跳过。**角色落地后的正确动作是重跑整个 `./apply.sh`**（全部文件幂等，一次覆盖以上四处），
  而不是逐个 `--only`。
- **pgvector / pgroonga 仍未安装**（需 superuser）。因此 `serve.chunk_embedding` 未创建、
  `text_chunk` 的 pgroonga 索引未建、全文检索仍是 `pg_trgm` 降级态。装完各自重跑
  `0008` / `0005` 即补齐（都幂等）。
- **`checks/` 与 `npm test` 未接进任何 CI** —— 仓库里没有可挂的 CI 配置，目前只能手工跑。
- **一次性测试库 `scpper-v2-gatetest` 已删除**（那是回填演练的现场，结论已写进 README）。

---

## Phase 2 回填收尾 gate（TODO #7）

三个文件：

| 文件 | 作用 |
|---|---|
| `migrations/0100_backfill_gate.sql` | `meta.v1_identity`（v1 id 暂存）/ `meta.v1_identity_load`（载入元数据）/ `meta.backfill_gate_run`（gate 留痕）+ 把两条身份序列收窄为 int4 域 |
| `checks/load_v1_identity.sh` | 在 v1 上**只读** `COPY (SELECT ...) TO STDOUT`，CSV 单向灌进 v2 的暂存表 |
| `checks/backfill_finalize.sql` | 50 条断言 + 序列重置 + 留痕；任一条不过 ⇒ `RAISE EXCEPTION` ⇒ psql 非零退出 |

### 为什么编号是 0100 而不是 0007

`0001`–`00xx` 留给 Phase 1 的 schema 迁移（本轮并行任务已占到 `0012`）。
本文件是 **Phase 2 专属**：它建的三张表在读切换完成后就只剩考古价值。
把 Phase 2 迁移收进独立的 `0100+` 区段，一是与 Phase 1 的编号竞争脱钩，
二是「哪些迁移在切换完成后可以退役」这个问题从此看编号就能回答。

### 跨库断言为什么要靠暂存表

`dblink` / `postgres_fdw` **都不是 trusted extension**，实测：

```
scpper-v2=> CREATE EXTENSION dblink;
ERROR:  permission denied to create extension "dblink"
HINT:   Must be superuser to create this extension.
```

`user_dxzbdi` 非 superuser ⇒ 这条路在本机是死的。所以「v1 Page.id ↔ v2 ingest.page.id
一一对应」这条 gacha 跨库软外键的硬承诺，只能先把 v1 的 id 集合单向搬进 v2，再做纯 SQL 断言。

### 跑法

```bash
# ① 载入 v1 身份 id（v1 侧只发 SELECT / COPY TO STDOUT）
export V1_DATABASE_URL=...        # scpper-cn
export USER_DATABASE_URL=...      # scpper_user（gacha 那一族）
./checks/load_v1_identity.sh              # 或 --dry-run 只做连通性与计数

# ② gate
psql "$SYNCER2_DATABASE_URL" -f checks/backfill_finalize.sql                  # strict（默认）
psql "$SYNCER2_DATABASE_URL" -v gate_mode=dryrun    -f .../backfill_finalize.sql         # 只断言，不动序列
psql "$SYNCER2_DATABASE_URL" -v gate_mode=bootstrap -f .../backfill_finalize.sql         # 空库只归位序列（passed 恒 false）
psql "$SYNCER2_DATABASE_URL" -v max_load_age='72 hours' -f .../backfill_finalize.sql
```

⚠ **顺序是 载入 → 回填 → 再载入一次 → gate**。断言 A0.7b 会拒绝「暂存快照早于
`ingest.page` 最新一行 `created_at`」的对账（回填在载入之后还在跑 ⇒ 现在对账没意义），
实测就是靠它把「先载入后回填再直接 gate」这个错误顺序挡下来的。

### 50 条断言分组

| 组 | 内容 |
|---|---|
| **A0**（fail-fast） | 库名 / 暂存表已载入 / 源库 ≠ 自己 / **v1 侧独立 count 与实际行数逐条对账** / 快照新鲜度 / 快照不早于最后一次身份注册 / strict 要求 v2 身份表非空 |
| **A1** | v1 Page.id 全在 v2；v2 在 v1 值域内无额外 id；**逐行 wikidot_id 相等**（防 id 整体错位）；wikidot_id 无重复；id 全为正 |
| **A2** | user 同构 + v1 有 wikidotId ⇒ v2 `kind='wikidot'` 且 wid 相等；v1 无 wikidotId（1,097 行）⇒ v2 `kind ∈ guest\|anon\|synthetic` |
| **A3** | gacha 引用的每个 `pageId`（36,957 个 distinct）都存在于 v2 `ingest.page` |
| **A4** | `max(id)` 落在 int4 域内；空洞诊断走 NOTICE（空洞本身无害，见下） |
| **A5** | `serve.page_current` ↔ `ingest.page` 双向差集为 0；wikidot_id 逐行相等；每页恰一个当前 slug；`page_current.slug` = 当前 slug；每页至少一条 `page_life_event` |
| **A6** | 重置后：15 条序列逐条 `已交付水位 >= max(id)`、**水位之上无已占用 id**；两条身份序列域是 integer；app identity 表集合 = `0004` 注释里的硬编码 13 张清单 |

**A0 的存在理由是「防止 gate 沦为安慰剂」**：`count(*) FROM (v1 EXCEPT v2)` 在暂存表为空时
返回 0，于是「一一对应」这条断言在**根本没载入**的情况下全绿。所以 `meta.v1_identity_load`
里存的 `expected_rows` 是在 v1 侧**独立 count** 得到的，与 v2 侧实际行数逐条对账 ——
不能用 COPY 的返回行数，那样「COPY 被截断」这件事就自证清白了。

### 三个设计决定

1. **序列只上调，绝不下调。** `0006` §4.0 注释里的 `setval(seq, max(id))` 在「水位已高于
   max(id)」的库上是**下调**（冒烟测试会把 `page_id_seq` 推到 14 而表里一行不留，实测就是
   这个状态），下调后 nextval 会重发那些曾被分配、只因事务回滚才没落库的 id。唯一性上不冲突，
   但「id 永不重排/复用」这条对外承诺就变成了「除了回滚过的那些」。
   （那段注释在**空表**上还会 `setval(seq, NULL)` ⇒ 22004，本脚本用 `COALESCE` + `is_called`
   分支处理。）
2. **app 序列动态发现，不硬编码表名。** `0004_app.sql` 文件尾注释里那段 `DO` 块硬编码了
   13 张表名；今天数目恰好正确（第 14 张 `app.collection_account_owner` 没有 id 列，实测确认），
   但下次给 app 加表就会静默漏掉一条，而漏掉的那张表 BFF 第一次 INSERT 就撞主键、gate 却全绿。
   断言 A6.4 专门比对「动态发现的集合」与「那份硬编码清单」，让注释过期这件事显形。
3. **「id 空洞冲突」的语义澄清。** `max(id)` 以下的空洞**无害**（v1 Page.id 从 301 铺到
   106,804 只有 47,861 行，天然 5.9 万个空位，序列不回填它们）。致命的是**序列水位之上还有
   已占用 id** —— 这才是 A6.2 断言的东西，也是「回填只灌了一部分 / 回填后忘了 setval」的必然症状。

### 端到端演练结果（2026-07-27，独立库 `scpper-v2-gatetest`）

在一个从零建起的独立库上应用全部迁移，把 v1 的 **47,861 页 + 37,455 用户**真的搬进去，
再跑 gate。**正反两条路径都实测过**：

| 场景 | 结果 |
|---|---|
| 空库 `bootstrap` | 37 断言全绿、exit 0、留痕 `passed=false`（跳过了跨库断言，不算通过） |
| 回填未做 + strict | `A0.8` fail-fast，exit 3 |
| 先载入→再回填→直接 gate | `A0.7b` fail-fast（快照早于回填），exit 3 |
| 回填完成（guest 用 `'guest:'\|\|displayName`） | **A2.1 FAIL：25 个 v1 User.id 缺失**，其余 49 条全绿，exit 3 |
| 修正 guest key 后 | **50/50 全绿**，exit 0，留痕 `passed=true` |
| 幂等重跑 strict | 50/50，exit 0 |
| `dryrun` | 50/50 且一个 `setval` 都不发 |
| 人为把 `expected_rows` +7 | `A0.5` 抓到截断，exit 3 |
| 人为改 2 行暂存 `wikidot_id` | `A1.3` FAIL 并回显 `id=301 v1_wid=32481449 v2_wid=32481448` |
| 人为 `setval(page_id_seq, 1000)` | `A6.1` + `A6.2` FAIL（`47,213 行 id > 1000`） |
| 删掉 gacha 载入记录 | `A3.1` SKIP ⇒ strict 判失败（债主没被检查过就不算验证过） |

### 演练中查实的三件事（都会影响真正的 Phase 2 回填脚本）

1. **单事务全量回填不可行。** `register_page` / `ensure_user` 都取
   `pg_advisory_xact_lock`（事务级，提交前不释放）。一个事务里灌 47,861 页实测：
   `ERROR: out of shared memory / HINT: You might need to increase "max_locks_per_transaction"`
   （本机 `max_locks_per_transaction=64`、`max_connections=100`）。
   ⇒ 回填必须**分批提交**（演练用 2,000/批，走 `PROCEDURE` + `COMMIT`；`DO` 块里不能 COMMIT）。
   单连接吞吐实测 ≈ 250 页/秒，47,861 页约 3.2 分钟。
2. **`ensure_user` 的 guest 同名合并会破坏「v1 User.id 一一对应」。**
   设计取舍 #14 规定 guest 的 `anon_key = 'guest:'||name`（同名合并），而 v1 的 1,097 个
   `wikidotId IS NULL` 用户只有 **1,072 个不同 displayName** ⇒ 按取舍 #14 回填会**少 25 行**，
   gate 的 A2.1 原样抓到（`37,430 ≠ 37,455`）。
   两条路二选一，需要产品/数据决策：
   (a) 回填期 guest 的 key 用 `'guest:v1:'||v1_id` 保 1:1，代价是 v1 里那 25 组同名 guest
       在 v2 仍是不同身份（与取舍 #14 的意图相反）；
   (b) 接受合并，那么 gacha 之外任何按 v1 `User.id` 的软引用都需要一张 id 映射表，
       且 A2.1 必须改成「允许多对一」。
   演练里走的是 (a)，只为把 gate 的绿路径跑通 —— **这不是决策，是待决项**。
3. **v1 `User.id` 值域极度稀疏**：37,455 行、`max(id) = 282,240,277`（8,743 行 id > 200 万），
   且 **0 行满足 `id = wikidotId`**（`User.id` 是独立自增，不是 wikidotId 的别名 —— 回填时
   图省事拿 wikidotId 当 id 会让 A2.1 与 A2.3 同时炸）。
   重置后 `ingest.user_id_seq` 落在 282,240,277，int4 余量约 18.6 亿。

### 顺手修掉的一个坑（`0100` §3）

`ingest.page_id_seq` / `user_id_seq` 由 `CREATE SEQUENCE` 的默认 bigint **收窄为 `AS integer`**。
两张身份表的 id 都是 `int`，而 `register_page` 写的是 `nextval(...)::int`：

```
setval('ingest.page_id_seq', 3000000000);   -- 收窄前：成功
SELECT ingest.register_page(...);           -- 明天：22003 integer out of range
```

`setval` 正是回填收尾要跑的动作，它接受一个 nextval 永远无法交付的值，错误因此从
「setval 当场报错」推迟到「某次真实注册页面时炸」，而那时现场已经不在 gate 里了。
收窄后 `setval` 自己就拒（22003），序列耗尽也变成语义正确的 2200H 而不是类型转换错。

---

## Prisma 映射（TODO #9）

```
syncer2/prisma/
  schema.prisma          ← db pull 生成 + 人工修正关系字段名（84 model / 4 schema / 5 enum）
  schema.header.prisma   ← 文件头注释块的权威副本（含 7 条降级说明与红线）
  pull.sh                ← 重新introspect 的唯一入口
```

* **是新独立文件**：`backend/prisma/schema.prisma`（v1 生产用）**未被触碰**。
  Prisma 的 datasource 是单例，一个 schema 文件只能对一个库生成一个 client；
  硬合并会让 v1 的 `migrate status` 把 v2 的表当成漂移要求删掉，
  也会让 `prisma.page`（v2）和 `prisma.Page`（v1）同时出现在一个 client 里。
* datasource → `env("SYNCER2_DATABASE_URL")`，`previewFeatures = ["multiSchema"]`，
  `schemas = ["app","ingest","meta","serve"]`。
  **meta 也纳入了**：`meta.ingest_run` / `page_scan` / `backfill_gate_run` 是运维/状态页的读源，
  而且 `parse_health_baseline` 有指向 `ingest_run` 的外键 —— Prisma 要求关系两端的 model 都在。
  同理 `ingest` 不可能排除（app 的外键全锚在 `ingest.page` / `ingest."user"`）。
* client 输出到 `node_modules/.prisma/syncer2-client`，与 v1 client 并存不打架。
* 实测：`prisma validate` 通过、`prisma generate` 通过、**84 model ↔ 84 张非分区表一对一**，
  16 个分区子表被正确排除。

### 🔴 只作读侧类型来源，不可用于 `prisma migrate`

权威 DDL 是 `migrations/*.sql`。`db pull` **系统性地丢掉或谎报**这些结构（逐条实测计数）：

| # | 结构 | Prisma 的处理 | 后果 |
|---|---|---|---|
| 1 | `ingest.vote_event` 分区表 | 降级成普通表，且主键渲染成 `@default(autoincrement())` | **谎报**。真实 DEFAULT 是 `nextval('ingest.fact_seq')`，那是四张事实表共享的全局摄入序（分区键 + 投影游标推进单位）。autoincrement 会给它一条自己独占的 bigserial ⇒ 跨表全序归并失效，且类型层面看不出来 |
| 2 | 30 条部分索引 | **静默丢弃**（整条不出现，不是把 WHERE 抹掉） | 其中 **8 条是部分唯一索引**，丢的是唯一性保证：`psh_current`（每页至多一个当前 slug）/ `pah_current` / `ps_rev` / `rev_pending` / `pvd_current` / `em_one_active` / `uniq_user_activity_follow_revision` / `uniq_user_activity_follow_attr_event` |
| 3 | 86 条 CHECK 约束 | 完全不支持（db pull 逐条列 warning） | 词表约束（`vote_event.kind`、`user.kind`、跨列「kind=wikidot ⇒ wid NOT NULL」）在类型层面不存在 |
| 4 | 28 个触发器 | 不可见 | `prisma.vote_event.update()` 类型合法，运行时被 `trg_immutable` 以 25006 拒掉 |
| 5 | 46 个函数（34 个 SECURITY DEFINER） | 不可见 | **ingest 的唯一正确写法是 `$executeRaw` 调 `apply_*`**；`prisma.vote_event.create()` 绕过 CAS 转移与 `page_current` 增量维护（= v1 fast-vote 直写聚合列的同型病） |
| 6 | 10 条非默认 NULLS 排序索引 | 不支持（warning） | `us_rating_*` / `uar_type_achieved` / `up_user_created` / `tvc_latest` 是排行榜分页索引，重建后 NULL 顺序退化 ⇒ 分页跳行 |
| 7 | `COMMENT ON COLUMN`（设计决策与实测结论都写在那里） | 只剩一行 `/// This model ... has comments in the database` | 别拿 schema.prisma 当文档，语义回 `migrations/*.sql` 看 |

### 命名决策

**保留 snake_case model 名，零 `@@map`** —— model 名与表名逐字一致。
v1 的 schema.prisma 是 PascalCase 因为 v1 的**表名**就是 PascalCase；v2 的 DDL 通篇 snake_case，
改成 PascalCase + `@@map` 会出现两套名字（SQL 里 `serve.page_current` / TS 里 `prisma.pageCurrent`），
而并行期需要频繁在迁移 SQL 与 BFF 代码之间对照，一套名字的价值高于命名风格统一。

人工修正的是**关系字段名**：同表多个外键指向同一 model 时 db pull 会生成
`user_forum_interaction_alert_actor_user_idTouser` 这类名字（**24 处**），已全部改成语义名
（`actor` / `recipient` / `follower` / `target_user` / `predecessor` / `successor` …）。
`@relation("...")` 里的关系名字符串刻意不动 —— 它是两侧配对的键，且不出现在生成的 API 里。

### 维护：一律用 `prisma/pull.sh`

```bash
cd syncer2 && ./prisma/pull.sh            # pull → 拼回注释块 → format → validate → generate → 自检
cd syncer2 && ./prisma/pull.sh --check    # 只 validate/generate/自检（CI 用）
```

实测出的一条不对称行为，也是这个 wrapper 存在的原因：

* ✓ re-introspection **保留**人工改过的关系字段名（24 处重跑 pull 后全部存活），
  并正确吸收并行任务新加的表（一次 pull 吸收了 4 张新 `serve` 表）；
* ✗ 但它**把文件头的 `//` 注释块整块删掉** —— 顶部 `//` 不属于 Prisma AST 的任何节点，
  重写文件时不落盘（挂在 model/field 上的 `///` 才保留）。
  那块注释装着上面 7 条降级说明和「不可 migrate」的红线，静默丢掉 = 下一个人照着
  schema.prisma 跑 `prisma migrate`，把分区表和 8 条部分唯一索引一起做掉。

`pull.sh` 的自检还会拦三件事：注释块是否在、`model 数 == 库里非分区表数`、
分区子表是否混进 schema，并报告新出现的 db pull 默认丑关系名。

### pgroonga

本文件的 datasource **不带** `extensions = [pgroonga]`（v1 的带）：scpper-v2 上扩展建不出来，
`0005` 已降级为 7 条 pg_trgm GIN 索引，在 schema 里表现为
`@@index([...(ops: raw("gin_trgm_ops"))], type: Gin)`。
trgm 只支撑 `ILIKE`，不支撑 `&@~` —— 读侧写 `&@~` 分支会**报错**而不是变慢。

## 后续 TODO

**需要 DBA / superuser 的（两条，越早做越好）—— 2026-07-27 已探明无本机通道，交接单已就绪**

先说结论：**本机确实没有 superuser 通道**，四条路逐条实测走死（`sudo` 要密码且无 NOPASSWD
条目、peer 认证 OS 用户不匹配、`pg_hba.conf` 与 `pg_hba_file_rules` 都读不到、
全库唯一 superuser 是 `postgres` 且无任何 `.env` / `.pgpass` 持有它的凭据）。
⇒ 已写 **`docs/dba-handoff.md`**（完整执行步骤 + 验证方法 + 不做的后果 + 回滚）。

1. **五角色**：DBA 只需执行 **`migrations/9001_create_roles.sql.ADMIN`**（整份只有 5 条
   `CREATE ROLE` + 5 条 `COMMENT`，~50 行）。之后应用侧自己跑
   `./apply.sh --only 9002_grants.sql` 即补齐授权矩阵，**不需要再重跑 `0006` 第 8 节**
   （9002 覆盖面更全）。
   已完成的验证（一次性容器 PG 17.10，跑完销毁）：9001/9002 各幂等重跑一次输出逐字相同；
   9002 第 10 节强制自检 8 负 + 2 正全通；**Phase 1 gate 的负向断言用真登录账号实测 11 条全中**
   （`bff_role` 写 `ingest.vote_event` → `ERROR: 42501: permission denied for table vote_event`）。
   ⇒ 原先记在这里的 T6.6 缺口已有实证，只剩"固化成 TS 测试"（见测试层 #10）。
   顺带确认：`apply_revision_batch` 的 `set_config('scpper.revision_backfill',…)` 在
   `ingestor_role` 身份下正常（会话级占位 GUC 不需要特权）。
2. **pgroonga**：DBA 只需 `CREATE EXTENSION IF NOT EXISTS pgroonga;`（**注意 `-d scpper-v2`**）。
   之后应用侧 `./apply.sh --only 0005_indexes_pgroonga.sql` 即得 7 条 pgroonga 索引。
   整条路径（含 DROP 7 条 `*_trgm` 的不停机切换）已在同版本容器演练通过，见上「pgroonga」一节。
   若决定**不装**，BFF **必须**实现 ILIKE 回退分支 —— 实测无扩展时 `&@~` 报
   `42883: operator does not exist`，读切换当天全文搜索是**报错**而不是变慢。
   `*_trgm` 的 DROP 时机与判据见 `docs/dba-handoff.md` §3.4（**不要与建索引同一步做**）。

**迁移/schema 层**

3. ~~`meta.projection_cursor` 的初始登记清单~~
   **✅ 已完成（2026-07-27，`migrations/0007_meta_gaps.sql` §3）**：27 个 Tier-2 投影全部登记，
   `rebuild_from` **由 DDL 直接从 `pg_description` 解析生成，不手抄** —— "逐字一致"因此不是
   靠人眼校对维持的，改了注释重跑 0007 即同步。Tier-1 三表刻意**不**登记（与事实同事务，
   无游标语义）。三道硬门：注释不以 `rebuild_from=` 开头 / 新增 Tier-2 表未声明
   `event_domain` / 映射残留指向不存在的表，任一命中即迁移失败（实测三条都真的拦住了）。
   漂移断言另建 **`checks/0001_projection_cursor_drift.sql`**（6 条，只读，可对生产库跑）。
4. ~~R10 熔断的**物理开关**仍缺位~~
   **✅ 已完成（2026-07-27，`0007` §2 + `0006` 各入口）**：`meta.write_freeze`（9 个域）+
   `meta.freeze_writes()` / `release_writes()` / `write_freeze_status()` /
   `assert_writes_allowed()` / `note_freeze_skip()`。14 个写入型函数入口各一道断言，
   被冻结抛 **`SQLSTATE PGF01`**。
   语义边界：**冻结写入、不冻结采集** —— `meta.*` 的证据链在冻结期照常写入（否则熔断期
   变成观测盲区，连"该不该熔断"都无法复盘）。逃生舱是独立 GUC `scpper.freeze_bypass`，
   **刻意不复用** `scpper.bypass_guard`（"我在做迁移"不该顺手关掉"上游可能是垃圾"的熔断）。
   接线断言另建 **`checks/0002_write_freeze_wiring.sql`**（含反向检查：新增 `apply_*`
   不登记进清单即失败）。⚠ 调用方契约：`PGF01` 会回滚整个事务连同它本该写的 `page_scan`，
   所以采集层必须先独立事务落证据、或捕获后调 `meta.note_freeze_skip()` 补写。
5. ~~红链无处安放 / 标签维度趋势无法落库~~
   **✅ 已决策并实现（2026-07-27，`migrations/0009_serve_modeling_decisions.sql`，可撤销）**：
   两处都各评估了 2 个方案，采纳"加一列文本自然键 + 放宽 int id 为可空 + 换主键"：
   `serve.page_reference` 主键 → `(from_page_id, target_slug, kind)`、`to_page_id` 可空
   （`NULL` = 红链）；`serve.trending_stats` 主键 → `(entity_type, entity_key, period)`、
   `entity_id` 可空（`tag` 维度用 `entity_key` 存标签文本）。未采纳方案与理由、以及**逐条
   rollback SQL** 都写在该文件里（回退会丢红链行与标签维度行，那正是"缺口"的具体含义）。
6. ~~`scan_task.kind` 词表缺 `forum` / `files` / `discussion`~~
   **✅ 已完成（`0007` §1）**：`scan_task.kind` 11 项、`page_scan.kind` 8 项（两端同步补齐 ——
   只放宽入队端会造出"任务能建、证据写不进"的断头路）。`discussion` 与 `forum` 刻意**分开**
   （单页讨论区 vs 论坛分类批量，`UNIQUE(page_id,kind)` 会让合并后的两类待办互相顶掉）；
   与 `meta.forum_scan_task`（`0012`，键是 `(kind,target_id)`）也是不同队列，分工见 `0007` §1 注释。
   `src/store/meta.ts` 的 TS 联合类型已同步（此前它比 DDL **窄**，缺 `sitemap_delta` /
   `new_page_highfreq`）。
6b. **`meta.record_page_scan` 的证据静默丢失已修**（`0006`，属 bug 修复）：`run_id` 为 `NULL`
   时原实现只 `RAISE WARNING` 就 `RETURN` —— 扫描证据凭空消失，而 `page_scan` 正是撤票/删除
   推断、`stable_count` 收敛与 `meta.irreconcilable` 的唯一输入。改为自动创建
   `source='synthetic'` / `status='running'` 的合成 run（每会话一个，GUC 记忆 + 存在性校验）。
   `status<>'ok'` 且 `coverage_ratio IS NULL` ⇒ **合成 run 永远无法授权任何 absence/删除推断**，
   "补上证据"不会顺带补上"授权"。CI/回填可 `SET scpper.require_run_id='on'` 转硬失败（22004）。
   顺带补上另一个静默缺口：`apply_forum_batch` 此前**从不写** `kind='forum'` 的 `page_scan`
   （词表里有、无人写 ⇒ 论坛域完全没有页级证据链），现在为每个被触及的 page 各记一条，
   `status` 只能是 `'partial'` —— 该函数没有任何完整性入参，记 `'ok'` 等于伪造 absence 授权凭证。
7. ✅ **已完成** —— Phase 2 回填收尾 gate。`0100_backfill_gate.sql`（暂存/留痕三表 +
   身份序列收窄为 int4 域）+ `checks/backfill_finalize.sql`（50 条断言 + 序列重置）
   + `checks/load_v1_identity.sh`（v1 身份 id 单向 COPY 载入器）。
   详见下节「Phase 2 回填收尾 gate」。
8. ✅ **已完成** —— 语义检索域的归属与 embedding 重算决策。
   全部实测数字与推理见 **`docs/embedding-migration.md`**；DDL 在
   `migrations/0008_serve_embedding.sql`，冒烟在 `checks/embedding_smoke.sql`
   （11 条通过 / 2 条待 pgvector）。要点：
   - **归属**：`PageEmbedding` → serve 层派生投影，拆成 `serve.text_chunk` +
     `serve.chunk_embedding` + `serve.page_semantic`（另加 `text_chunker` /
     `embedding_model` 两张契约表、`embedding_backlog` 视图、`semantic_coverage()` 函数），
     全部登记 `meta.projection_cursor`（`ON CONFLICT DO NOTHING`，不覆盖 TODO #3 的清单；
     `rebuild_from` 由 `obj_description()` 读回，构造上不可能与注释漂移）。
   - **`SearchIndex` / `SearchChunk` 不迁**：实测生产库里 `to_regclass` 皆为 NULL，
     `hybrid_search()` / `check_embedding_coverage()` 两个函数也不存在，
     `EmbeddingService` / `HybridSearchService` 全仓零引用 —— 整条链路是死代码。
     唯一活着的消费者是 qqbot 的 `/sem`（且其 embed 服务 `127.0.0.1:18080` 当前未监听）。
   - **决策：全量重算一次。** 语义差异其实很小（100 页实测中位数 0.00%、86% 的页 ≤1%），
     但 v1 分块是**纯字符定长滑窗**（窗口 1500 / 步长 1300 / 上限 16 块，逆向自生产库偏移，
     100/100 吻合），正文任一处变化都会平移其后全部边界 ⇒ 实测 **99.71% 的 chunk 内容会变**，
     "只对变更页增量"在切换时刻等价于全量。
   - **成本：零 API 费用**（自托管 BGE-M3），实测吞吐 92.2 chunk/min（CPU-only，无 GPU）
     ⇒ 全量 ≈128,000 chunk ≈ **23.1 小时墙钟**，可完全放在切流之前跑。
   - 顺带修掉 v1 三个量化缺陷：偏移指向可变文本（抽样 5.3% 已错位）、
     无任何增量机制（16.1% 当前态页从无向量、4,120 个向量挂在非当前版本上）、
     `sourceTruncated` 全库为 false 而实测 1,029 页真被截断。
   - 新增 `src/content/extractText.ts`（零依赖正文提取原型）与
     `experiments/extract-vs-crom.ts`（差异度量脚本）。**遗留**：`[[html]]` 块
     （≈3% 页面）的二次抓取未实现，必须在全量重算**之前**补上，否则要重算两遍。
9. ✅ **已完成** —— Prisma multiSchema 映射。**新独立文件** `prisma/schema.prisma`
   （`schemas = ["app","ingest","meta","serve"]`，datasource 指 `SYNCER2_DATABASE_URL`，
   client 输出到 `node_modules/.prisma/syncer2-client`）。`backend/prisma/schema.prisma`
   未被触碰。84 model ↔ 84 张非分区表一对一，`prisma validate` / `generate` 通过。
   详见下节「Prisma 映射」——**含 7 条 Prisma 表达不了的结构与降级说明**。

**测试层**

10. ~~把冒烟里做不到的三组补上：**多会话**乱序提交注入（T7.1/T7.2，需要两个连接 —— 单文件 psql
    做不到，得用 TS 测试或两个 psql 协程）、5,575 条大批 + 属性测试生成器（T5.2）、
    `bff_role` 权限被拒（T6.6，等角色落地）。~~
    **✅ 已完成（2026-07-27）**：`tests/t7-cursor-safety.test.ts`（32）/
    `tests/t5-vote-batch.test.ts`（49）/ `tests/t6-role-permission.test.ts`（17 通过 + 6 跳过），
    共 **98 通过 / 0 失败 / 6 跳过**，`npm run test:gates`。见下文「多连接 TS 测试」。
11. ~~把 HTTP 护栏（本地测试服打 503/500/gzip）、`parse.ts` 结构断言、时区回环这三组
    手工验证固化成 test 文件 —— 目前采集层**没有自动化测试**。~~
    **✅ 已完成（2026-07-27）**：`tests/http.test.ts`（25）/ `tests/parse.test.ts`（31）/
    `tests/db.test.ts`（19），共 **75 条断言组**，`npm run test:offline` + `npm run test:db`。
    见下文「采集层自动化测试」。顺带做了三处代码改动：`src/sitemap/normalize.ts`（把
    `parse_drop_rate` 的产地从 CLI 内联逻辑提成纯函数，才可单测）、`parse.ts` 加第 4 道结构
    断言（**根元素闭合检查**，防截断响应变成幻影删除）、`runExistenceOnly` 的 drop_rate
    口径与 `runPageScan` 对齐。

**采集层**（延续前几轮的 TODO）

12. ~~`meta.ingest_run.exit_ip_stats` 未填充（49 节点轮换池无 fallback 无健康检查，
    不记出口 IP 则"某几个节点坏了"不可归因）。~~
    **✅ 已完成（2026-07-27）**：`src/http/egress.ts` + `HttpClient` 的 `egress` 选项。
    两个信源、可信度分开写清：
    · **IP 回显探针**（`api.ipify.org`，经同一个 dispatcher）—— 启动 1 次 + 每 N 个请求 1 次
      （默认 25）+ 失败补探，单轮封顶 8 次，**刻意不是每请求都探**。实测每次探针都换 IP
      （连续三次三个不同 IP），所以它的语义是**池构成**，不是相邻请求的出口；
    · **mihomo 本地控制器 `/connections`** —— `chains[0]` 就是承载该连接的**节点名**
      （实测 `["🇺🇸 美國 CN2 20260727","🔀 负载均衡(爬虫IP池)"]`），按连接的真值、
      本机 HTTP 零 wikidot 成本。`transportFailureByNode` 就是"哪几个节点坏了"的答案。
    落库形状里带一行 `attribution` 口径声明 —— 半年后看这张表的人靠它判断能不能下结论。
    实跑落库样例见 `meta.ingest_run` 中 `source='wikidot_sitemap'` 的行。
13. ~~启动自检缺第三道：一次真实 AMC POST 探针（防 Referer/UA 契约再变）+ 代理健康探测。~~
    **✅ 已完成（2026-07-27）**：`src/http/amc.ts` 的 `assertEgressContract()`。
    · AMC 探针 = 真打一个 `POST /ajax-module-connector.php`（`list/WikiCategoriesModule`，
      随机 `wikidot_token7` 双提交），并做**结构断言**（status=ok 且 body 能解析出 category 映射，
      实测 42 个）—— 只校验 HTTP 200 是不够的，"200 + status ok + body 变形"必须也被识破。
      顺手拿到 category 名↔数字 id 映射进 `stats.startupProbe`，站点换皮/改分类时能定位时点。
    · 失败**指数退避重试**（3 次，2s→4s，cap 20s，jitter），重试耗尽才非零退出；
      但 503/429 与断路器打开时**立刻停手不再重试**（否则自检本身成了 503 洪水的发动机）。
    · 代理健康 = 两条独立判据：(a) mihomo `chains[0]` 是否 `DIRECT`；
      (b) 经代理与直连的出口 IP 是否相同 ⇒ 抓的是"代理静默回落直连、用家宽 IP 抓站"这种
      **不报错的**故障。
    · 策略按通道自动判定（`amcProbePolicyFor()`）：sitemap / 整页 GET 是纯 GET ⇒ `skip`；
      走 AMC 的通道 ⇒ `require`。**接 ListPages 只改这一处常量**，或
      `--amc-probe require` / `SYNCER2_AMC_PROBE=require` 立刻打开。
14. ~~未解析 slug（真·新页）的消化链路、thread/category sitemap 与 `ingest.forum_thread` 的差集入队。~~
    **✅ 已完成（2026-07-27）**：新迁移 `migrations/0012_collector_queues.sql`（两张队列表）
    + `src/store/queues.ts` + 新 CLI `src/cli/resolve-pages.ts`。
    · **真·新页**：`meta.pending_page`（slug 主键）。不能复用 `meta.scan_task` ——
      那张表 `page_id NOT NULL`，而 pending 的定义就是"page_id 还不存在"。
      消化链路：整页 GET → `WIKIREQUEST.info.pageId` → `ingest.register_page` →
      回填 page_id + 下 `scan_task(meta)` 与 `scan_task(new_page_highfreq)`。
      **逐页独立容错**（不是库里 `acquirePageIds` 那种"一页失败整批失败"）：
      404 ⇒ `gone`（sitemap TTL≈60min 的正常竞态，不是错误）；
      200 但 `pageUnixName` ≠ 请求 slug ⇒ `mismatch` 且**拒绝注册**（否则等于把 A 的 slug
      绑到 B 的 wikidot_id 上）；其它失败保留在队列里走 1h/4h/24h/7d 退避。
      另有**冷启动闸**：pending > 2000 时拒绝自动跑（空库 3.6 万条 = 3.6 万次 GET，
      与 field-matrix 的"绝不为全站 36k 页各打一次 GET"冲突，该走 Phase 2 回填）。
    · **论坛差集**：`meta.forum_scan_task`（`UNIQUE(kind,target_id)`）。thread sitemap
      只给 id，凑不出 `ingest.forum_thread` 一行合法记录（那张表 category_id/title/created_at
      全 NOT NULL），所以只能进队列。实跑入队 **86,904 thread + 14 category**。
      **反向差集刻意不产出任何东西** —— 实测 sitemap 对`翻译预定区(归档)`与`垃圾桶`
      两个隐藏分类系统性失明，"sitemap 没有"不构成消失证据。
    · 两张表的发现侧 UPSERT 只碰 `last_seen_at / seen_count / reasons / priority(取大)`，
      **绝不覆盖** `attempts / not_before / stable_count / status / locked_*`（已实测验证：
      人为置脏后重跑，执行侧状态逐列不变、`seen_count` 从 1 变 2、无重复行）。
15. ~~sitemap **不能**替代 SiteChanges 做十分钟级新页发现，发现层应交给 ListPages。~~
    **✅ 文档修正已完成（2026-07-27）**：本 README 的架构描述与「sitemap 通道实测账」已按
    实测重写（TTL≈60 min / 排序键是"最后活动"而非 lastmod / 禁止 lastmod 阈值早停 /
    新页最坏 44.5 min vs ListPages 13.5 min / absence 四分类硬排除 / md5 短路 /
    ≥2 轮间隔须 > 1 TTL），并新建修订附录
    **`../docs/data-model-v2-addendum-2026-07-27.md`**（不改受保护 checkout 里的原设计文档，
    也不改 worktree 里的原文，便于追溯）。
    附录内容：§1 被推翻的四条结论、§2 R1–R15 逐条落地状态（其中 **R3/R4 被本轮进一步修订**
    —— sitemap 也不做发现层，ListPages 重新承担发现层）、§3 六个 blocker + Phase 0 增补六项、
    §4「唯一常驻源」决策的理由/七条代价/立场、§5 分域权威表与修订后的触发矩阵与请求预算、
    §6 十一条仍然悬空的决策。
    **剩下的实现工作**（不属于文档修正）：把 ListPages 的两条快通道
    （`order=updated_at desc` / `order=created_at desc`，各 1 请求 @3 min）真的接进来 —— 这是
    #14 的前置，也是 blocker B6（"稳定跑通一次完整 Tier1"）的一部分。
16. `SiteChangesModule` 的时效**完全未测**。若最终需要硬 SLA 的秒级发现，它是唯一剩下的候选。
    另：sitemap 的 TTL 是否按文件独立（只测了 `page_1`）也未验 —— 若 `page_2..4` 不同步重生成，
    跨文件对账会短暂看到重复/缺失条目，所以全量 absence 基准**必须在一次 run 内连续抓完 4 个文件**，
    并把"两文件都缺"作为唯一判据。
17. **`meta.ingest_gate` 需要一个周期清理任务**（T7 测试查实，见「多连接 TS 测试」末条）：
    `apply_*` 只调 `ingest_gate_open()`，从不调 `ingest_gate_close()`，所以每个摄入事务提交后
    都留一行（状态 `committed`，不影响水位正确性，但表会单调增长）。
    加一条调度即可：`*/15 * * * * psql "$SYNCER2_DATABASE_URL" -c 'SELECT meta.ingest_gate_sweep();'`
    ——或在 projector 每轮开头调一次。**顺带的告警价值**：sweep 之后若仍有
    `txid_status = 'in progress'` 且 `started_at` 很老的行，那就是崩溃/挂死的写者，
    它会一直压着安全水位不让游标前进（表现为"投影停更但没有任何报错"），必须告警。

**整合期（2026-07-27）新确认的剩余项**

18. **没有 CI，`checks/` 与 `npm test` 只能手工跑。** 仓库里没有可挂的 CI 配置文件。
    最小可用形态是一条脚本按序跑：`apply.sh`（幂等重跑）→ `smoke_test.sql` →
    `checks/run_checks.sh` → `npm test`。四者在整合验证里就是这个顺序、全绿，
    但**没有人在每次改动后自动跑它们**——TODO #3 的漂移断言、#4 的熔断接线断言、
    #10/#11 的测试全部依赖"有人记得跑"。
    ⚠ 一个已知的 CI 前提：跑冒烟/T7 时**不能有并发写者**。`safe_seq_watermark()` 会因为
    别人的长事务持有 `pg_advisory_xact_lock_shared(gate_key)` 而三次 try 全部拿不到锁并返回
    `NULL`——那是设计内的"摄入侧繁忙则本轮不推进"，不是缺陷，但会让 S6 段整段变红。
19. **`projection` 域尚未接线。** `checks/0002` 的反向断言只覆盖 `ingest.apply_*`，
    projector 落地后必须在其入口调 `meta.assert_writes_allowed('projection')` 并加进该文件的
    `v_must` 清单 —— 否则 projector 漏接熔断，`checks/0002` **不会**自动发现。
20. **R10 的自动触发链仍然缺位。** `meta.write_freeze` 是执行体，但"每轮把
    `ingest_run.parse_fingerprint` 与 `meta.parse_health_baseline` 比对、越界即
    `freeze_writes('all', …)`"这个判定作业还没有人写（属采集/健康检查侧）。目前只能人工 freeze。
21. **冻结期的证据补写依赖调用方守约，TS 侧还没实现。** `PGF01` 会回滚整个事务，
    所以 `meta.note_freeze_skip()` 必须由采集层在**新事务**里调。
    `store/meta.ts` 的 `recordPageScans` 本身是独立事务（"先落证据再调 `apply_*`"这条路径天然
    满足），但**没有针对 `PGF01` 的显式 catch 分支与遥测字段**。
22. **`scan_task` 的 `forum` / `discussion` / `files` 三种 kind 目前没有任何入队者**，
    `meta.forum_scan_task` 的 86,917 条也**没有消化者**。词表与队列就位是为了让抓取器落地时
    不用再改 schema，但"有队列、无消费者"本身是下一轮要填的实现空缺。
23. **`meta.pending_page` 的约 1 万条待解析是冷启动积压，不该由 `resolve-pages` 消化**
    （一页一个整页 GET）。正确出路是 Phase 2 批量回填——v1 库里已有 `wikidot_id`。
    回填做完后这批会被 `resolveSlugs` 自然解析掉，队列收敛到日常量级（实测新页+改名 30–80/天）。
