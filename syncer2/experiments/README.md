# syncer2 / experiments

v2 采集架构的实测实验目录。所有脚本可重跑，所有 wikidot 请求走 `http://127.0.0.1:7891` 代理并携带
`User-Agent` + `Referer`（缺 Referer 的 AMC POST 会被 TCP reset，空 UA 会 503）。
主库连接一律**只读**。

| 文件 | 说明 |
|---|---|
| `sitemap-probe.sh` | 任务 F 采集脚本：`snap` / `full` / `forum` / `cattotal` / `chase` / `regen` / `series` / `parse-*` |
| `sitemap-analyze.py` | 离线分析：`lag` / `drift` / `order` / `domain` / `threads` |
| `chase-analyze.py` | 把 chase 高频轮询数据折算成 sitemap 滞后的夹逼区间 |
| `sitemap-probe.md` | **任务 F 报告**（中文，含全部数字与结论） |
| `extract-fetch.sh` | 任务 C 数据采集：`sample` / `export` / `fetch` —— 分层抽 100 页、导出 v1 `textContent` 与真实 chunk 边界、抓整页 HTML（100 次 GET，可断点续跑） |
| `extract-vs-crom.ts` | 任务 C 度量：CROM `textContent` vs 我方 `extractTextContent(html)` 的行级 LCS 差异 + 分块边界变化；`--emit-chunks` 可导出 `serve.text_chunk` 的 COPY 输入 |
| `dump-extract.ts` | 排查用：打印单页的提取结果与 warnings |
| `data/` | 原始 XML / AMC 响应 / 只读 DB 导出 / 中间 TSV / `data/extract/`（任务 C 的 HTML 缓存） |

任务 C 的结论文档是 [`../docs/embedding-migration.md`](../docs/embedding-migration.md)。

复现步骤见 `sitemap-probe.md` §7。
