# IMGEVID：图片内容判定与投票证据终态修复报告

验收时间：2026-08-17 16:38 CST  
工作树：`feat__syncer2-foundation`（基线 `e9b9233`，未 commit、未 push）  
目标数据库：`scpper-v2`（PostgreSQL 5434）

## 结论

- `invalid_content_type` 的 failed 数从题设基线 9,366 降到 **817**，下降 **8,549 / 91.3%**。动手前活库读数为 9,360；两者相差 6 是生产队列并发变化。
- 已知误拒核心集合 8,292 条全部通过迁移恢复；同时纳入同构的 `en.wikipedia.org` 127 条和 `scp-jp.wdfiles.com` 102 条。首次恢复 8,521 条，幂等复跑又捕获 1 条新出现的 Commons 失败，审计 cohort 现为 **8,522**。
- 16:38 快照中 cohort 已有 **52 张实际抓取并写入 `asset_sha`**；另有 90 条经字节检查确认是 HTML 等非图片，转为 `invalid_image_content` 正当终态，其余在限速队列中消化。
- 四个投票任务均已从 `scan_task` 移除，并各自进入 `meta.irreconcilable` 的 **`listpages_unenumerable`** 终态；全库 `scan_task.attempts >= 7` 为 **0**。
- 处理四页的 work-queue run 36723 为 `partial`、shell exit 0、`repeatedFailures=0`、`irreconcilable=4`、health reasons `[]`；之后 18 轮 `wikidot_tier2` 全部 `ok`，最大 `repeatedFailures=0`。
- 没有阻塞项。剩余恢复队列会按既有站外预算继续消化，无需牺牲 Wikidot L1。

## 1. 图片修复

### 1.1 内容是事实，响应头只是证据

新增 `src/image/contentValidation.ts`，`Content-Type` 和 URL 扩展名都不参与是否为图片的真值判定。worker 下载完、通过 20 MiB 上限后，按响应字节识别：

| 格式 | 字节判据 |
|---|---|
| PNG | 8-byte signature、IHDR 长度/类型、非零宽高 |
| JPEG | SOI 加合法 segment/scan marker 结构 |
| GIF | GIF87a/GIF89a 加非零画布尺寸 |
| WebP | RIFF/WEBP 加 VP8、VP8L 或 VP8X chunk 与长度边界 |
| AVIF | ISO-BMFF `ftyp` box 边界和 `avif`/`avis` brand |
| BMP/ICO/TIFF | 固定 signature 加文件/目录/IFD 边界 |
| SVG | UTF-8、`svg` 根元素；拒绝 script、事件属性、外链、HTML 嵌入及 CSS URL 能力 |

防误纳措施不是看后缀：固定 magic、廉价容器不变量、长度边界和尺寸共同成立才保存；HTML 即使叫 `.webp` 且声明 `image/webp` 也会得到 `invalid_image_content`，不生成 SHA。安全 SVG 采用更严格的白名单式子集。最终 MIME 和扩展名只取检测结果，资产仍走 SHA-256 分层路径、临时文件 + fsync + 原子 rename；已有 v1 文件既不修改也不删除。

新失败分类：

- `invalid_image_content`：响应字节不是支持的图片；确定性终态。
- `description_page_unresolved`：已识别的 Wikimedia File 描述页没有安全的真实图片 URL；确定性终态。
- 两者与历史 `invalid_content_type` 一样从站点健康压力分子排除，但保留可审计失败记录。

### 1.2 Wikimedia 描述页二跳

只有以下 URL 才允许把 HTML 当描述页解析：

- host 为 `commons.wikimedia.org` 或 `*.wikipedia.org`；
- path 为 `/wiki/File:...`（大小写不敏感）。

从 `og:image` 取目标后，只接受无凭据的 `upload.wikimedia.org` HTTPS URL。普通站外 HTML 不解析 meta，不会成为开放重定向或 SSRF 跳板。二跳继续使用同一个 external client，因此 exact-host breaker、全局预算、每主机 12 秒间隔、重试和失败分类都不绕过。二跳响应仍必须通过 magic bytes；没有安全 OG URL 则显式进入 `description_page_unresolved`，不会无限重试。

### 1.3 迁移及恢复范围

涉及 schema，严格先应用 `migrations/0071_image_content_validation_recovery.sql`，再部署代码。迁移完成三件事：

1. 扩展 `image_ingest_job_failure_class_ck`；
2. 把已知六个 host 上未锁定的 `invalid_content_type` 任务重置为 `pending, attempts=0`；
3. 在 `page_image.metadata` 写入 `content_validation_recovery_migration=0071`，形成可重算 cohort。

迁移带受保护 v1 数据库 guard，且只更新数据库状态；磁盘资产只以新 SHA 路径新增。

16:38 cohort 快照：

| host | 恢复数 | 已入库 | 确认非图片终态 | pending |
|---|---:|---:|---:|---:|
| commons.wikimedia.org | 4,710 | 24 | 0 | 4,686 |
| en.wikipedia.org | 127 | 24 | 0 | 103 |
| scp-wiki-cn.wdfiles.com | 1,565 | 0 | 24 | 1,541 |
| scp-wiki.wdfiles.com | 1,048 | 0 | 24 | 1,024 |
| scpsandboxcn.wdfiles.com | 970 | 3 | 20 | 946 |
| scp-jp.wdfiles.com | 102 | 1 | 22 | 79 |

表内还有 1 条当时由 worker 持锁处理中，因此各状态列相加比 8,522 少 1。队列持续运行，数字会继续变化。

### 1.4 活库成功样本

Wdfiles octet-stream WebP：

```text
URL      https://scpsandboxcn.wdfiles.com/local--files/baby-bat/39089.webp
declared application/octet-stream
detected image/webp
bytes    26410
sha256   3dc3bfd788164e6c0ab97e108f6ff8a01727986a648e6095f3822ebf3eed4d89
path     3d/c3/bf/3dc3bfd788164e6c0ab97e108f6ff8a01727986a648e6095f3822ebf3eed4d89.webp
```

Wikimedia 描述页：

```text
source   https://commons.wikimedia.org/wiki/File:Eniac.jpg
resolved https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/.../1280px-....jpg
detected image/jpeg
sha256   7958fb9745e350841e84a88503dbd4e000713a11533ecdd1dac03363d52e6bc5
path     79/58/fb/7958fb9745e350841e84a88503dbd4e000713a11533ecdd1dac03363d52e6bc5.jpg
```

已终态的恢复条目首 16 bytes 均为 `3c21444f43545950452068746d6c2050`，即 `<!DOCTYPE html P`；说明 magic bytes 正在拒绝真实 HTML，而不是把它们按图片扩展名误纳。

### 1.5 消化速率与预计耗时

systemd timer 为 5 分钟 worker + 完成后 5 分钟再调度。最近三轮实际 settled（completed + deterministic failed）分别为 55、41、75，共 **171 条 / 30 分钟，约 342 条/小时**；对应 external request 为 59、56、98。

16:38 尚有约 8,379 条 pending。按当前混合流量的点估计约 **24.5 小时**；考虑其他站外 backlog、二跳和 host cooldown，运营区间给 **24–30 小时**。这不是解除限速后的理论峰值。

## 2. 四个投票证据任务

### 2.1 根因

对四个 slug 的 targeted exact-fullname ListPages 请求都成功返回同一个 58-byte 结构：

```html
<div class="list-pages-box">

</div>
```

这不是 WAF、传输失败或任意空 HTML，而是“请求成功但目标不在可枚举集合”的结构完整空结果。2026-08-17 收尾时对四个页面的 `/norender/true/noredirect/true` 直接 GET 也全部返回 HTTP 404：

| page_id | slug | 远端 GET | targeted ListPages | 结论 |
|---:|---|---:|---|---|
| 1500006407 | old:scp-1046 | 404 | 结构完整空 | 当前不可枚举；`old:` 归档语义仅为旁证 |
| 1500000206 | scp-cn-4156 | 404 | 结构完整空 | 当前不可枚举 |
| 1500002362 | scp-cn-4698 | 404 | 结构完整空 | 当前不可枚举 |
| 1500001245 | scp-sb | 404 | 结构完整空 | 当前不可枚举；沙盒命名仅为旁证 |

它们是 v2 活库中的历史身份，但远端当前不可枚举。旧 parser 把完整空盒当成“缺 pager 的解析失败”，generic prerequisite policy 又要求重试，故 attempts 可无限增长。根因裁决依赖 HTTP 404 + exact ListPages 空证据，不依赖 slug 前缀猜测。

### 2.2 语义终态

- `parseTargetedVoteClaim` 只在 exact targeted 模式识别唯一空 `list-pages-box`，返回 `unavailable/listpages_unenumerable`；全站 L1 的 pager 严格性完全不变。
- handler 仍 fail closed：不使用 `page_current.rating` 等本地聚合值写投票，并把远端证据写入 `page_scan`。
- failure policy 把该分类路由为 structural `vote_claim_listpages_unenumerable` / `irreconcilable`，清除 `scan_task`，进入每周可审计复查，而不是高频无限重试。

活库结果：四条 open irreconcilable 的 `terminal_classification=listpages_unenumerable`、`targeted_claim=structurally_empty`、`checks=1`，下次复查为 2026-08-24；`attempts>=7` 为 0。

## 3. 健康度与回归证据

### L1 未受影响

最近五个生产全站 L1 均为 `source=wikidot_listpages, status=ok, pages_enumerated=36,671`：

| run | duration |
|---:|---:|
| 36912 | 88.583 s |
| 36819 | 92.819 s |
| 36767 | 94.004 s |
| 36726 | 88.777 s |
| 36718 | 91.378 s |

五轮均在题设 86–110 秒量级内。

### 站外健康严格分账

最近图片生产轮：external claimed 78、completed 25、retry 3、failed 50、98 个 external requests；Wikidot route claimed 0，`wikidotSite.status=ok`，总 exit 0，输出明确为 `externalFailuresAffectWikidotHealth=false`。描述页二跳和 wdfiles 下载都只走 external host gate，站外失败不进入 Wikidot 健康分子。

### 自动化回归

| 检查 | 结果 |
|---|---|
| octet-stream WebP 按内容识别并写 SHA 路径 | pass |
| 非图片伪装 `.webp` 且声明 `image/webp` 仍拒绝 | pass |
| Wikimedia 描述页解析到 allowlisted OG 图片并二跳 magic 校验 | pass |
| 描述页无安全 OG URL 进入明确终态 | pass |
| ListPages 结构完整空集合进入 irreconcilable，不触发 repeated failure | pass |
| 定向回归 | 34/34 |
| `npx tsc --noEmit` | pass |
| `npm test` | **575/575**（基线 568 + 新增 7） |
| `git diff --check` | pass |

## 4. 变更范围与限制

主要变更：`src/image/contentValidation.ts`、`src/image/descriptionPage.ts`、`src/image/worker.ts`、`src/image/health.ts`、`src/collect/votes.ts`、`src/work/handlers.ts`、`src/work/failurePolicy.ts`、迁移 0071 及相应测试。

- 未改动 `/home/andyblocker/qqbot`，未发送 QQ 消息。
- 未修改或删除任何 v1 图片文件；新内容只新增 SHA 路径。
- `invalid_content_type=817` 是本次六 host 之外的历史失败，不应在没有内容证据时批量放行；新 worker 已不再产生该分类。
- 队列快照是动态值；本报告用 migration metadata 作为稳定 cohort 定义，后续可重算成功数和 ETA。
