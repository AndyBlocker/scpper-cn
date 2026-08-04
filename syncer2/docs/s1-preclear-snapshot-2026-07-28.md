# S1 真跑前 v2 冷启动数据快照

- 采样时间：2026-07-28 10:05:54 +08:00
- 目标库：`scpper-v2`
- 采样角色：`user_dxzbdi`
- 用途：记录 WIRE 冷启动演练产物被清理前的状态；这不是可恢复数据备份。
- 口径：表行数均为 `count(*)` 精确值；分区表只记父表汇总。

## 身份摘要

| 实体 | 行数 | min(id) | max(id) | `id:wikidot_id` 有序 MD5 |
|---|---:|---:|---:|---|
| `ingest.page` | 118 | 23 | 614 | `50bd428c3a2f8545daaa11bd50579e28` |
| `ingest."user"` | 501 | 74,300 | 166,012 | `8ccdf0ec91859b6a9c92d94769ca6c84` |

## ingest 非空表

| 表 | 行数 |
|---|---:|
| `ingest.content_blob` | 5 |
| `ingest.forum_category` | 16 |
| `ingest.forum_post` | 2 |
| `ingest.forum_thread` | 1 |
| `ingest.page` | 118 |
| `ingest.page_attr_history` | 440 |
| `ingest.page_life_event` | 118 |
| `ingest.page_slug_history` | 118 |
| `ingest.page_source` | 5 |
| `ingest.revision` | 24 |
| `ingest."user"` | 501 |
| `ingest.vote_event`（分区汇总） | 1,660 |

`ingest.attribution_event` 与 `ingest.page_lineage` 为 0 行。

## serve 非空表

| 表 | 行数 |
|---|---:|
| `serve.embedding_model` | 1 |
| `serve.page_current` | 118 |
| `serve.page_daily_stats` | 104 |
| `serve.page_stats` | 104 |
| `serve.text_chunker` | 2 |
| `serve.user_stats` | 501 |
| `serve.user_tag_preference` | 5,010 |
| `serve.vote_current` | 1,660 |
| `serve.vote_daily` | 104 |

其余 `serve.*` 表均为 0 行；全部 `app.*` 表均为 0 行。

## meta 采集证据与运行态

| 表 | 行数 |
|---|---:|
| `meta.forum_scan_task` | 86,917 |
| `meta.ingest_run` | 39 |
| `meta.page_scan` | 599 |
| `meta.parse_health_baseline` | 52 |
| `meta.pending_page` | 10,115（pending 9,997 / resolved 118） |
| `meta.projection_cursor` | 32 |
| `meta.reconcile_report` | 4 |
| `meta.scan_task` | 234 |
| `meta.write_freeze` | 9 |

其余 `meta.*` 表为 0 行。`meta.ingest_run` 的实际 id 为 8–332（序列水位 392），
来源包括 sitemap、page identity、Tier2、forum、fault drill、reconcile 与受控 110 页演练。

## 清理前序列

| 序列 | 类型 | max_value | last_value |
|---|---|---:|---:|
| `ingest.fact_seq` | bigint | 9,223,372,036,854,775,807 | 691,240 |
| `ingest.page_id_seq` | integer | 2,147,483,647 | 766 |
| `ingest.user_id_seq` | integer | 2,147,483,647 | 206,030 |
| `ingest.page_attr_history_id_seq` | bigint | 9,223,372,036,854,775,807 | 518 |
| `ingest.page_slug_history_id_seq` | bigint | 9,223,372,036,854,775,807 | 776 |
| `ingest.page_source_id_seq` | bigint | 9,223,372,036,854,775,807 | 15 |
| `meta.ingest_run_id_seq` | bigint | 9,223,372,036,854,775,807 | 392 |
| `meta.forum_scan_task_id_seq` | bigint | 9,223,372,036,854,775,807 | 86,917 |
| `meta.scan_task_id_seq` | bigint | 9,223,372,036,854,775,807 | 924 |

## 同时刻只读源基线

源库连接使用 `default_transaction_read_only=on`：

| 源 | 行数/引用数 | min(id) | max(id) |
|---|---:|---:|---:|
| v1 `Page` | 47,875 | 301 | 106,818 |
| v1 `User` | 37,474 | 13,537 | 282,758,650 |
| `scpper_user.GachaCardDefinition` distinct `pageId` | 36,971（82,215 张定义） | 301 | 106,818 |

v1 `Vote` 为 6,349,919 行，其中 `anonKey IS NOT NULL` 为 0。

## 清理决策

除 `meta.write_freeze` 的闸配置外，清空全部 `ingest.*`、`serve.*`、零行的 `app.*`
以及 `meta.*` 采集证据/队列/游标，并 `RESTART IDENTITY`。理由是这些 meta 运行态均指向
本次 WIRE 演练；保留会让首次正式爬取继承旧任务、旧游标和稀疏的 `ingest_run` id 水位。
表、schema、约束、函数和迁移历史均不删除。

## 执行记录

- 2026-07-28 10:08:21 +08:00：在全域写闸下完成事务性清理。
- 因 `meta.write_freeze.breach_run` 引用 `meta.ingest_run`，保留闸表、置空演练 breach 指针，
  `ingest_run` 采用 `DELETE` 并把其序列重启到 1；其余目标表统一清空。
- 13 个事实表防误删 TRUNCATE trigger 仅在该事务内临时关闭，提交前全部恢复为 enabled。
- 提交后精确复核：page/user/slug/vote/page_current/ingest_run/pending/forum task/scan task 均为 0。
- 随后解除全域维护闸；S1 进程自己的 identity 写闸在完成后也已释放。
