# 修订源码全文回填

## 决策

PageDiff HTML 不是两侧源码的可逆编码，因此不再用于源码重建。`0027` 保留队列、
逐条退避、irreconcilable、断点进度、存活页守卫、低优先 timer 和独立
`population_type`，抓取与存储改为：

1. 对存活页的源码修订逐 `revision_id` 调 `history/PageSourceModule`。
2. 解析出的完整源码按 UTF-8 字节计算 sha256。
3. 用 `ingest.content_blob` 内容寻址入库；相同字节只存一份。
4. 通过受控写入口把 `ingest.revision.source_sha` 从 NULL 单向补为该 sha。

基线目标为 347,686 条，原始估算 88.6 KB/条、约 31 GB。队列按当前 live 事实动态
补入，因此运行时总量会包含基线之后的新修订；报告须同时给出基线和当时动态总量。

## 门禁与运行

- `npm run revision-source:pilot` 固定处理 1,000 条：900 个历史版本、100 个当前源码
  版本。每条都在写入后从 `content_blob` 经 `revision.source_sha` 回读并逐 UTF-8
  字节比较；100 个当前版本再与 `ViewSourceModule` 逐字节交叉验证。
- pilot 从已有当前源码正面证据（`page_current.source_sha IS NOT NULL`）的公开 live 页
  抽样，并排除实测历史 PageSource 匿名返回 `no_permission` 的 `deleted:` 归档命名空间。
  这个抽样条件不缩小长跑队列：其余 live 页仍会入队，访问拒绝会按正常
  退避/irreconcilable 留证，绝不伪装为成功。
- pilot 可断点续跑：已由全文写入口补过 `revision.source_sha` 的样本会重新计算 blob
  sha/字节数并回读验证，不再重复请求 PageSource；缺失样本才触网。100 个当前版本
  无论是否命中断点，都会重新请求 ViewSource 做交叉验证。
- 门禁成功记录为 `meta.revision_source_pilot(parser_version='page-source-v1')`；
  长跑找不到 1000/1000 且 0 失败的记录时拒绝认领。
- 长跑单并发、请求间隔至少 250 ms，不加速。timer 只在 `:25/:55` 启动短进程，
  L0/L1 活跃时跳过。
- job 保存源码字节、模块响应字节、sha 和 `blob_inserted`，可据此计算速率、带宽和
  内容寻址去重率。CLI 同时记录数据库、content_blob 与磁盘余量变化。
- 每 100 条复查磁盘；根文件系统可用空间不足 100 GiB 时停止认领并报告。

## 后续：标签变更史

PageDiff 的“标签: A → B”是独立结构化字段，不受源码区域 `nl2br` 丢失行级归属影响，
仍然可靠。这是 v1 完全没有的能力。后续可用少量 PageDiff 请求单独采集标签变更史；
它不承担源码重建，也不与 PageSource 全文回填冲突。本任务不实施该采集。
