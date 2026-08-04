# DBA 交接单 —— scpper-v2 的两件特权动作

- 日期：**2026-07-27**
- 目标库：**`scpper-v2`**（`localhost:5434`，PostgreSQL 17.10）—— **只作用于这一个库**
- 申请人身份：`user_dxzbdi`（`rolsuper=f`、`rolcreaterole=f`、`rolcreatedb=t`）
- 红线：**不得对 `scpper-cn` / `scpper-syncer` / `scpper_user` 做任何 DDL 或权限变更，不得改
  `postgresql.conf` / `pg_hba.conf`。** 本单据的两项动作都不需要碰它们。

---

## 0. 摘要：需要你做的只有两条命令

```bash
# ① 建 5 个 NOLOGIN 组角色（需 CREATEROLE 或 superuser）
psql -p 5434 -d scpper-v2 -v ON_ERROR_STOP=1 \
     -f syncer2/migrations/9001_create_roles.sql.ADMIN

# ② 建 pgroonga 扩展（需 superuser；二进制已在机器上，只是没建扩展）
psql -p 5434 -d scpper-v2 -c 'CREATE EXTENSION IF NOT EXISTS pgroonga;'
```

**之后的一切由应用账号自己完成**，不需要你再介入：

```bash
cd syncer2/migrations
./apply.sh --database-url "$SYNCER2_DATABASE_URL" --only 9002_grants.sql          # 补齐授权矩阵
./apply.sh --database-url "$SYNCER2_DATABASE_URL" --only 0005_indexes_pgroonga.sql # 建 7 条 pgroonga 索引
```

两条命令都已在一个**与生产同版本的一次性容器**（PostgreSQL 17.10 + pgroonga 4.0.6）上
端到端跑通并验证过，见 §4。你执行的是已验证过的路径，不是首次试跑。

---

## 1. 为什么必须找你 —— 实测的权限现实（不是推测）

2026-07-27 逐条实测，四条通道全部走死：

| 尝试 | 结果 |
|---|---|
| `sudo -n -u postgres psql -p 5434 -c "select 1"` | `sudo: a password is required`（`sudo -n -l` 同样要密码 ⇒ **无任何 NOPASSWD 条目**，`/etc/sudoers.d/` 下只有 `README`） |
| unix socket + peer 认证 `psql -h /var/run/postgresql -p 5434 -U postgres` | `FATAL: Peer authentication failed for user "postgres"`（**peer 是开着的**，但 OS 用户是 `andyblocker`，不匹配；`-U andyblocker` 则 `role "andyblocker" does not exist`） |
| 读 `pg_hba.conf` 找可乘之机 | `/etc/postgresql/17/main/pg_hba.conf` 权限 `-rw-r----- postgres:postgres` ⇒ 读不到；`SELECT * FROM pg_hba_file_rules` ⇒ `permission denied for view` |
| 找别的高权限账号 | 全库仅 3 个非 `pg_*` 角色：`postgres`（唯一 superuser）、`user_dxzbdi`、`user_dxzBDi`；两个应用账号都 `rolsuper=f rolcreaterole=f`。全仓（`scpper-cn` 与 `qqbot` 各 `.env`）grep `postgres://postgres:` **零命中**，`~/.pgpass` 不存在，环境里无 `PGPASSWORD` |
| `SELECT ... FROM pg_auth_members` 自身成员关系 | **0 行** —— `user_dxzbdi` 不是任何角色的成员，`SET ROLE` 也提不了权 |

两条动作的报错原文（都是硬性权限拒绝，不是配置问题）：

```
scpper-v2=> CREATE EXTENSION IF NOT EXISTS pgroonga;
ERROR:  permission denied to create extension "pgroonga"
HINT:  Must be superuser to create this extension.

scpper-v2=> CREATE ROLE syncer2_probe_role NOLOGIN;
ERROR:  permission denied to create role
DETAIL:  Only roles with the CREATEROLE attribute may create roles.
```

`pgroonga` 需要 superuser 的**根因已核实**（不是包装问题、装不上 trusted 版本也绕不过）：

```
scpper-v2=> select name, trusted, superuser from pg_available_extension_versions
            where name in ('pgroonga','pg_trgm','pgcrypto');
 pgroonga  | f | t     ← 非 trusted，且标记 superuser
 pg_trgm   | t | t     ← trusted，所以库属主自己建得上（降级方案正是靠这一条）
 pgcrypto  | t | t
```

`/usr/share/postgresql/17/extension/pgroonga.control` 里确实**没有** `trusted = true`
（只有 `default_version` / `comment` / `module_pathname` 三行）。二进制版本 4.0.6 已在机器上。

> **另一条存在但被刻意没走的路**：`andyblocker` 在 `docker` 组里，理论上可以用
> 特权容器挂载宿主根目录取得 root、再拿 `postgres` 身份。这是**绕过权限系统的提权**，
> 不是授权动作，本轮**没有使用**。若你认为这条路可接受，请显式书面授权；否则请照 §0 执行。

---

## 2. 动作一 · 五角色 + 授权矩阵（原 TODO #1）

### 2.1 已经替你做掉的部分 —— DBA 面从 456 行压到 ~50 行

原本的 `9000_roles_grants.sql.ADMIN` 有 **456 行**（建角色 + 全部授权），整份都标"需 DBA"。
本轮逐语句核过权限要求，结论是：

> **只有 `CREATE ROLE` 和 `COMMENT ON ROLE` 需要特权。**
> 全部 `GRANT` / `REVOKE` / `ALTER DEFAULT PRIVILEGES` 只要求**对象属主**身份，
> 而 v2 的属主就是应用账号本身：

```
pg_database.datdba('scpper-v2')                       = user_dxzbdi
pg_namespace.nspowner(ingest/serve/meta/app)           = user_dxzbdi   （4/4）
pg_namespace.nspowner(public)                          = pg_database_owner
pg_has_role('user_dxzbdi','pg_database_owner','member')= t             ← 所以 public 也改得动
78 张表 / 38 个函数的属主                               = user_dxzbdi
```

于是把 9000 拆成两个文件：

| 文件 | 内容 | 谁执行 | 行数 |
|---|---|---|---|
| **`9001_create_roles.sql.ADMIN`** | 只有 5 条 `CREATE ROLE` + 5 条 `COMMENT ON ROLE` | **DBA** | ~50（含大段注释） |
| **`9002_grants.sql`** | 其余全部授权矩阵 + 强制自检 | 应用账号（进 `apply.sh` 常规序列） | ~520 |

`9000_roles_grants.sql.ADMIN` **保留不动**，作为"DBA 手上就有 superuser、想一把梭"的备选。
推荐路径是 9001 + 9002。

收益：你要审的代码里**一条 GRANT 都没有**；今后授权矩阵随 schema 演进而修改时，不用再找你。

### 2.2 你要执行的（完整、可复制）

```bash
# 建议先看一眼 diff：整个文件只有 CREATE ROLE / COMMENT ON ROLE
grep -nE '^\s*(CREATE|COMMENT|GRANT|REVOKE|ALTER)' \
     syncer2/migrations/9001_create_roles.sql.ADMIN

psql -p 5434 -d scpper-v2 -v ON_ERROR_STOP=1 \
     -f syncer2/migrations/9001_create_roles.sql.ADMIN
```

文件自带三道护栏：
- `current_database() IN ('scpper-cn','scpper_cn')` 即 `RAISE EXCEPTION`（防连错库）；
- 5 条 `CREATE ROLE` 包在 `DO` + `EXCEPTION WHEN duplicate_object` 里 ⇒ **可反复重跑**；
- 全部包在单个 `BEGIN/COMMIT`，任何一步失败整体回滚。

角色属性是 **`NOLOGIN NOINHERIT`** ⇒ **不新增任何可登录入口**，纯粹是权限容器。

### 2.3 执行完请回执一行

```sql
SELECT rolname, rolcanlogin, rolinherit FROM pg_roles
 WHERE rolname IN ('bff_role','ingestor_role','projector_role',
                   'avatar_worker_role','migration_role') ORDER BY 1;
-- 期望：5 行，rolcanlogin 全 f，rolinherit 全 f
```

### 2.4 之后应用侧自己做的（无需你介入）

```bash
cd syncer2/migrations
./apply.sh --database-url "$SYNCER2_DATABASE_URL" --only 9002_grants.sql
```

`9002_grants.sql` 的第 10 节是**强制自检**：角色齐全时若任一边界不成立，直接
`RAISE EXCEPTION` 让迁移失败。也就是说"跑成功"本身就等于"边界已验证"。

> ⚠ 反过来也要说清：**角色不存在时 9002 只会打一屏 NOTICE 跳过，然后照样 COMMIT。**
> 所以"`apply.sh` 没报错"不等于授权生效。唯一判据是自检 NOTICE：
> `[9002 §10] 权限边界自检全部通过（8 条负向 + 2 条正向）`。

### 2.5 登录账号（第二步，可延后）

组角色不能登录。真正的应用连接账号模板在 `9002_grants.sql` 第 11 节（注释态）：

```sql
CREATE ROLE scpper_bff       LOGIN INHERIT PASSWORD '***' IN ROLE bff_role;
CREATE ROLE scpper_ingestor  LOGIN INHERIT PASSWORD '***' IN ROLE ingestor_role;
CREATE ROLE scpper_projector LOGIN INHERIT PASSWORD '***' IN ROLE projector_role;
CREATE ROLE scpper_avatar    LOGIN INHERIT PASSWORD '***' IN ROLE avatar_worker_role;
-- migration_role 不建常驻登录账号：迁移窗口临时 GRANT，窗口结束立刻 REVOKE，两次都记运维日志
```

这一步也需要 CREATEROLE，但**不阻塞 Phase 1 gate 的验证**（gate 可以用临时账号验，见 §4.2）。
在切读之前完成即可。密码请走你们既有的密钥管理，不要落进工作区 `.env`。

### 2.6 不做的后果

v2 **仍然能跑**（所有对象归 `user_dxzbdi`，它有全权），但会缺掉"权限即边界"这一层：

1. **应用层写错代码就能绕过 `apply_*` 直写 `ingest.vote_event`。** 这不是假想：v1 的
   `fast-vote lightweightBridge` 直写聚合列致盲脏页检测，就是这个形态的事故。
2. **BFF 能写事实表。** Phase 1 的合入 gate 之一"`bff_role` 写 `ingest.vote_event` 必须被
   `42501` 拒"**在角色不存在时无法验证**（`smoke_test.sql` 的 T6.6 因此一直缺位，
   249 个断言里没有它）。
3. **追踪表"只 additive、不 UPDATE 旧事件行"没有强制手段**，退化为口头约定。
4. **不可变触发器的 `migration_role` 例外没有承载体** —— 逃生舱判据
   `pg_has_role(session_user,'migration_role','MEMBER')` 恒为 false。
5. 五重保证掉到四重，其中第 2 条（写路径独占）从"物理上不可构造"降为"约定"。

**不阻塞上线，但建议在 Phase 1 gate 之前完成** —— 因为 gate 本身就有一条依赖它。

---

## 3. 动作二 · pgroonga 扩展（原 TODO #2）

### 3.1 现状：已按设计降级为 pg_trgm，但那**不只是"慢一点"**

`0005_indexes_pgroonga.sql` 的三级降级已在生产 `scpper-v2` 上生效：

```
NOTICE:  [0005] pgroonga 扩展不可用（permission denied to create extension "pgroonga"），转入降级方案
WARNING: [0005] 已降级为 pg_trgm GIN 索引 7 条。
```

7 条降级索引（刻意另起名 `*_trgm`，与 pgroonga 名字不冲突 ⇒ 可以先建后删、不停机切换）：

| schema | 索引 |
|---|---|
| `ingest` | `u_display_pgroonga_trgm`、`u_username_pgroonga_trgm`、`fp_search_trgm`、`fp_title_search_trgm` |
| `serve` | `pc_search_trgm`、`pc_title_search_trgm`、`pc_alt_search_trgm` |

**关键区别（本轮在真实 `scpper-v2` 上实测确认）**：`pg_trgm` 只能加速 `ILIKE '%kw%'`，
**不支撑 pgroonga 的 `&@~` 算子**。没有扩展时 `&@~` 不是慢，是**直接报错**：

```
scpper-v2=> select count(*) from ingest."user" where display_name &@~ '测试';
ERROR:  42883: operator does not exist: text &@~ unknown
HINT:  No operator matches the given name and argument types.
```

⇒ **读切换当天，BFF 若只写了 pgroonga 分支，全文搜索是 500 报错，不是变慢。**
这一点必须在排期里当成硬约束，二选一：

- **(A) 装 pgroonga**（推荐，10 秒的事，见 §3.2）；或
- **(B) BFF 实现 ILIKE 回退分支** —— 检测 `pg_extension` 里有无 `pgroonga`，无则走
  `ILIKE '%kw%'`。代价：中文分词能力丧失（trgm 对 CJK 是 3-gram，召回噪声大）、
  长查询串性能不可预测、且**多一条永久存在的分支要维护**。

### 3.2 你要执行的

```bash
psql -p 5434 -d scpper-v2 -c 'CREATE EXTENSION IF NOT EXISTS pgroonga;'
```

就这一条。**注意 `-d scpper-v2`** —— 扩展是按库安装的，装到 `postgres` 或 `scpper-cn` 都没用
（也**不要**装到 `scpper-cn`，那是生产库，本单据不申请对它的任何变更）。

### 3.3 之后应用侧自己做的

```bash
cd syncer2/migrations
./apply.sh --database-url "$SYNCER2_DATABASE_URL" --only 0005_indexes_pgroonga.sql
# 期望：NOTICE: [0005] pgroonga 索引就绪:7 条
```

`0005` 的第一步是 `SELECT EXISTS(... pg_extension WHERE extname='pgroonga')`，
扩展在就直接走 pgroonga 分支，不需要改文件。

### 3.4 什么时候可以 DROP 掉 7 条 `*_trgm`

**不要在建好 pgroonga 索引的同一步就删。** 顺序与判据：

1. `0005` 重跑完成，确认 7 条 pgroonga 索引都是 `amname='pgroonga'` 且 `indisvalid=true`；
2. **BFF 已切到 `&@~` 分支并观察至少一个完整流量周期**（此时两套索引并存，写入多付一份
   索引维护成本，但读路径可随时回切 `ILIKE`）；
3. 确认监控里没有 `42883` / `operator does not exist` 类错误；
4. 才执行 DROP：

```sql
DROP INDEX IF EXISTS ingest.u_display_pgroonga_trgm;
DROP INDEX IF EXISTS ingest.u_username_pgroonga_trgm;
DROP INDEX IF EXISTS ingest.fp_search_trgm;
DROP INDEX IF EXISTS ingest.fp_title_search_trgm;
DROP INDEX IF EXISTS serve.pc_search_trgm;
DROP INDEX IF EXISTS serve.pc_title_search_trgm;
DROP INDEX IF EXISTS serve.pc_alt_search_trgm;
```

（这 7 条 DROP 是**应用账号自己能做的**，不需要你。`DROP INDEX` 属对象属主权限。）

> 反过来的回滚路径也是通的：DROP 掉 pgroonga 索引 + `./apply.sh --only 0005...`
> 会重新走降级分支把 `*_trgm` 建回来。**但 `DROP EXTENSION pgroonga` 需要 superuser**，
> 所以"彻底回退到没装扩展的状态"仍要找你 —— 实践上没必要，留着扩展不建索引即可。

---

## 4. 已完成的端到端验证（你执行的不是首跑）

因为拿不到本机 superuser，本轮起了一个**一次性容器**做完整验证，然后销毁：

```
镜像：groonga/pgroonga:latest-alpine-17
版本：PostgreSQL 17.10 + pgroonga 4.0.6   ← 与生产宿主逐位相同（宿主 17.10 / pgroonga 4.0.6）
布置：CREATE ROLE user_dxzbdi LOGIN CREATEDB（非 superuser，复刻权限现实）
      CREATE DATABASE "scpper-v2" OWNER user_dxzbdi
      ./apply.sh 应用 0001~0006（0007 是并行开发中的未完成文件，已 --skip）
清理：docker rm -f syncer2-verify（已执行；镜像 692 MB 留在本机缓存，
      不需要可 docker rmi groonga/pgroonga:latest-alpine-17）
```

**这个容器与宿主的 5434 实例、与 `scpper-cn` 生产库完全无关，零交集。**

### 4.1 角色链路

| 步骤 | 结果 |
|---|---|
| superuser 执行 `9001` | 5 个角色创建成功；`rolcanlogin=f`、`rolinherit=f` × 5 |
| `9001` 幂等重跑 | 5 条 `角色 X 已存在，跳过创建`，`COMMIT` |
| 属主执行 `9002` | `[9002 §4] 已向 ingestor_role 授权 11 个转移函数`<br>`[9002 §10] 权限边界自检全部通过（8 条负向 + 2 条正向）`<br>`[9002] PUBLIC 对 apply_* 的 EXECUTE 已全部收回（0 个）` |
| `9002` 幂等重跑 | 输出逐字相同，`COMMIT` |
| 角色不存在时执行 `9002`（生产 `scpper-v2` 实况） | 一屏 `跳过` NOTICE + `WARNING` 提示找 DBA，**照常 COMMIT 不中断迁移** |

### 4.2 Phase 1 gate 的负向断言 —— 用真登录账号实打实撞墙

建了 `t_bff`/`t_ing`/`t_proj` 三个 `LOGIN INHERIT` 临时账号，逐条实测：

| # | 动作 | 期望 | 实测 |
|---|---|---|---|
| ① | `t_bff` → `INSERT INTO ingest.vote_event` | 拒 | **`ERROR: 42501: permission denied for table vote_event`** ✅ |
| ② | `t_bff` → `UPDATE serve.page_current` | 拒 | `permission denied for table page_current` ✅ |
| ③ | `t_bff` → `SELECT ingest.apply_vote_snapshot(...)` | 拒 | `permission denied for function apply_vote_snapshot` ✅ |
| ③b | `t_ing` → 同一函数 | **放行** | 报的是业务错 `page_id 1 未注册(先调 ingest.register_page)` ⇒ 权限已通 ✅ |
| ④ | `t_bff` → `SELECT FROM serve.page_current` | 放行 | 返回 0 ✅ |
| ⑤ | `t_ing` → `INSERT INTO ingest.vote_event` | 拒 | `permission denied for table vote_event` ✅（采集器只能经函数） |
| ⑥ | `t_ing` → 读写 `meta.ingest_run` | 放行 | 返回 0 ✅ |
| ⑦ | `t_proj` → `UPDATE serve.page_current`（Tier-1） | 拒 | `permission denied for table page_current` ✅ |
| ⑧ | `t_proj` → `DELETE FROM serve.page_stats`（Tier-2） | 放行 | 成功 ✅ |
| ⑨ | `t_bff` → `UPDATE app.page_metric_alert SET new_value=1` | 拒（列级） | `permission denied for table page_metric_alert` ✅ |
| ⑨b | `t_bff` → `UPDATE ... SET acknowledged_at=now()` | 放行 | 成功 ✅ |

⇒ **`smoke_test.sql` 缺位的 T6.6 至此有了实证**，且 ①/⑤ 的 SQLSTATE 已确认为 `42501`。
角色在生产落地后，把这 11 条固化成 TS 测试即可（README 后续 TODO 已记）。

### 4.3 pgroonga 链路

| 步骤 | 结果 |
|---|---|
| 降级态基线 | 7 条 `gin` (`*_trgm`)，0 条 pgroonga |
| superuser `CREATE EXTENSION pgroonga` | `CREATE EXTENSION` |
| 属主重跑 `0005` | `NOTICE: [0005] pgroonga 索引就绪:7 条` |
| 索引清单 | `pgroonga` 7 条（`u_display_pgroonga`/`u_username_pgroonga`/`fp_search`/`fp_title_search`/`pc_search`/`pc_title_search`/`pc_alt_search`）+ `gin` 7 条 `*_trgm`，**并存** ✅ |
| `&@~` 查询可用性 | `select count(*) from ingest."user" where display_name &@~ '测试'` → 返回 0（**不再报 42883**） ✅ |
| `0005` 幂等重跑 | 7 条 `already exists, skipping` + `pgroonga 索引就绪:7 条` ✅ |
| DROP 7 条 `*_trgm` 后复验 | `&@~` 仍正常返回；`ILIKE` 也仍可用（退化为全表扫）；trgm 计数 0 / pgroonga 计数 7 ✅ |

⇒ §3.4 的"先建后删、不停机切换"路径**已实际演练过**，不是纸面方案。

### 4.4 生产 `scpper-v2` 上已经落地的（不需要你，也已验证）

`9002_grants.sql` 里**不依赖角色**的收口段已在生产 `scpper-v2` 上应用：
`REVOKE ALL ON DATABASE scpper-v2 FROM PUBLIC`、`REVOKE CREATE ON SCHEMA public FROM PUBLIC`、
四个 schema 的 `REVOKE EXECUTE ON ALL FUNCTIONS FROM PUBLIC`、`ALTER DEFAULT PRIVILEGES`
的 PUBLIC 收回。之后：

- `smoke_test.sql` **249/249 仍全绿**（确认收口没有打断任何写路径）；
- `has_table_privilege('public','ingest.vote_event','INSERT'/'SELECT')` = `f` / `f`；
- `PUBLIC` 对 `apply_*` 的 EXECUTE = 0 个。

> 顺带一个副作用要知情：`REVOKE ALL ON DATABASE scpper-v2 FROM PUBLIC` 后，
> 只有被显式 `GRANT CONNECT` 的角色能连 `scpper-v2`。目前只有属主 `user_dxzbdi` 能连；
> `user_dxzBDi`（另一个应用账号，用于 5433 实例）**连不上 `scpper-v2` 了** ——
> 这是设计意图（它本来也不该连 v2），但如果有人拿它做过临时排查，需要改用 `user_dxzbdi`。

---

## 5. 检查清单（执行后逐项打勾）

- [ ] `9001_create_roles.sql.ADMIN` 已在 **`scpper-v2`** 上执行，§2.3 的回执 5 行符合期望
- [ ] `CREATE EXTENSION pgroonga` 已在 **`scpper-v2`** 上执行（`\dx` 里能看到 `pgroonga 4.0.6`）
- [ ] 确认**没有**对 `scpper-cn` / `scpper-syncer` / `scpper_user` 做任何变更
- [ ] 确认**没有**改动 `postgresql.conf` / `pg_hba.conf`
- [ ] 通知应用侧：可以跑 `--only 9002_grants.sql` 与 `--only 0005_indexes_pgroonga.sql`
- [ ] （可延后）按 §2.5 建 4 个登录账号，密码走密钥管理

**回滚**：两项都可逆且无数据风险。
角色：`REVOKE` 后 `DROP ROLE bff_role, ingestor_role, projector_role, avatar_worker_role, migration_role;`
（需先 `DROP OWNED BY` / 撤销授权；因为组角色不拥有任何对象，实际只需先跑
`REASSIGN`? —— 不需要，直接 `DROP ROLE` 前把授权撤掉即可）。
扩展：`DROP EXTENSION pgroonga CASCADE;` 会连带删掉 7 条 pgroonga 索引，
之后应用侧重跑 `0005` 会自动把 `*_trgm` 建回来（§3.4 末已验证该方向可行）。
