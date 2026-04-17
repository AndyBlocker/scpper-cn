# PostgreSQL 性能调优（2026-04-17）

本文档记录一次 PG 运行时参数调优，目标是让 planner 更准确估计 IO 成本，
并减少写入密集场景下的 checkpoint 抖动。

变更通过 drop-in 文件 `docs/ops/postgresql-50-performance-tuning.conf`
安装到 `/etc/postgresql/17/{main,replica}/conf.d/` 生效，**不修改**发行版
自带的 `postgresql.conf`，便于回滚。

## 背景

- 主机：64 GB RAM、NVMe SSD
- 集群：`pg_lsclusters` 显示 `17/main`（5434，应用）和 `17/replica`（5433）
- 原始运行值（`SELECT ... FROM pg_settings`）：
  - `effective_cache_size = 4GB`（默认，未设置）
  - `random_page_cost = 4`（默认，针对 HDD）
  - `effective_io_concurrency = 1`（默认）
  - `max_wal_size = 1GB`（默认）
  - `min_wal_size = 80MB`（默认）
  - `shared_buffers = 16GB`、`work_mem = 128MB`、`maintenance_work_mem = 2GB`（已合理，保持不变）

## 变更摘要

| 参数 | 旧值 | 新值 | 原因 |
|---|---|---|---|
| `random_page_cost` | 4.0 | 1.2 | NVMe 上随机/顺序读成本接近相等；避免 planner 在中大型表上错选 seq scan |
| `effective_cache_size` | 4GB | 32GB | 告知 planner 操作系统可用文件缓存；影响 index scan 选择（不分配内存） |
| `effective_io_concurrency` | 1 | 256 | NVMe 支持多条并发预取，bitmap heap scan 受益 |
| `max_wal_size` | 1GB | 2GB | 减少 syncer 批量写、gacha 结算时 checkpoint 频率 |
| `min_wal_size` | 80MB | 160MB | 与 max 同比例放大，减少 WAL 段回收 |

未变更的项：
- `shared_buffers`（16GB）、`work_mem`（128MB）、`maintenance_work_mem`（2GB）、
  `max_connections`（500）维持现状
- `default_statistics_target`（100）保留默认；若后续发现某大表统计信息抖动再单独提升

## 同步：安装 `pg_trgm` 扩展

审计发现 `pg_extension` 只有 `pgroonga` + `plpgsql`。`pg_trgm` 在后续可能用于
ForumPost 模糊搜索、卡片名称前缀/相似度匹配。本 PR 顺带通过 SQL 安装：

```sql
\c scpper-cn
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

脚本：`scripts/ops/enable-pg-trgm.sql`。

## 生效方式

1. 将 `docs/ops/postgresql-50-performance-tuning.conf` 复制到
   `/etc/postgresql/17/main/conf.d/` 和 `/etc/postgresql/17/replica/conf.d/`。
2. 大部分参数属于 `SIGHUP` 类（`reload` 即可），但 `max_wal_size`/`min_wal_size`
   也是 SIGHUP 类，因此整体使用 **reload** 即可，无需重启。
3. 安装 `pg_trgm`：`psql -f scripts/ops/enable-pg-trgm.sql`。
4. 可选：运行 `SELECT pg_reload_conf();` 或 `systemctl reload postgresql@17-main`。

一键执行见 `scripts/ops/apply-pg-tuning.sh`（需要 sudo）。

## 回滚

删除两个 drop-in 文件后 reload：

```bash
sudo rm /etc/postgresql/17/main/conf.d/50-performance-tuning.conf
sudo rm /etc/postgresql/17/replica/conf.d/50-performance-tuning.conf
sudo systemctl reload postgresql@17-main
sudo systemctl reload postgresql@17-replica
```

`pg_trgm` 扩展若需要卸载（一般不必）：`DROP EXTENSION pg_trgm;`。

## 验证

重载后在 `scpper-cn` 上执行：

```sql
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN (
  'random_page_cost', 'effective_cache_size', 'effective_io_concurrency',
  'max_wal_size', 'min_wal_size'
)
ORDER BY name;
```

`source` 列应显示 `configuration file`，不再是 `default`。

## 参考

- PostgreSQL docs: Server Configuration
- PGTune heuristic：64GB / NVMe 轮廓
- 审计报告 `docs/full-repo-audit-2026-03-16.md`（前一轮安全审计基础）
- 本轮审计遗留：部分/复合索引缺失（见 Bucket D PR）
