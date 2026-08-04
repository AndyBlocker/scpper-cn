# 语义检索域：归属、实测差异与 embedding 重算决策

> 2026-07-27 · 对应 `syncer2/README.md` 后续 TODO **#8**
> 对应 `qqbot/analysis/wikidot-vs-crom-2026-07-27/synthesis.md` §2.6（P1 新发现）与 **D9**
> 实测代码：`src/content/extractText.ts`、`experiments/extract-vs-crom.ts`
> DDL：`migrations/0008_serve_embedding.sql`、冒烟：`checks/embedding_smoke.sql`

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 要不要全量重算 embedding？ | **要，全量重算一次。** 不是因为语义差异大（实测中位数 0.00%），而是因为 v1 的分块是**纯字符定长滑窗**，正文任一处变化都会平移其后所有 chunk 的边界 —— 实测 **99.71% 的 chunk 内容会变**，"只对变更页增量"在切换时刻等价于"全量"。 |
| 成本 | **自托管、零 API 费用。** 实测 v1 那轮 124,955 chunk 用了 **23 小时 09 分**（92.2 chunk/min，CPU-only Xeon 6248 × 80 线程）。v2 全量 ≈ **128,000 chunk ≈ 23.1 小时墙钟**。唯一的账是这 23 小时的 CPU，不是钱。 |
| 能不能不重算，先凑合用？ | **不能，而且现状比"不重算"更糟**：v1 的向量是 2026-04-21/22 一次性生成后**再没更新过**（没有任何代码引用 `PageEmbedding` 的写入侧）。实测当前 38,087 个有正文的当前态页里 **6,142 页从来没有向量**、**4,120 个有向量的版本已经不是当前版本**、抽样 **5.3% 的页字符偏移已经和文本对不上**（切出来的 snippet 是错位文本）。 |
| 归属 | `PageEmbedding` → **serve 层派生投影**，拆成 `serve.text_chunk` + `serve.chunk_embedding` + `serve.page_semantic`，全部登记 `meta.projection_cursor` 并声明 `rebuild_from`。`SearchIndex` / `SearchChunk` **不迁**（见 §1.3：它们在生产库里根本不存在，整条链路是死代码）。 |

---

## 1. 现状盘查（读代码 + 读生产库，不靠文档）

### 1.1 真正活着的那条链路

生产库里只有一张表：

```
PageEmbedding  678 MB / 124,955 行
  heap 14 MB + 索引 334 MB（其中 HNSW 325 MB）+ TOAST ≈ 330 MB
  id, pageVersionId → PageVersion(id) ON DELETE CASCADE
  model varchar(64) = 'BAAI/bge-m3'（全表唯一取值）
  dim = 1024, embedding halfvec(1024)
  chunkIndex / chunkTotal / chunkCharStart / chunkCharEnd
  sourceCharLen / sourceTruncated
  UNIQUE (pageVersionId, model, chunkIndex)
  HNSW (embedding halfvec_cosine_ops) m=16 ef_construction=64
```

**唯一的消费者是 qqbot**，不是网站：`qqbot/src/plugins/scpper/queries.py` 的
`semantic_search()`（`/sem`、`/语义` 命令，`commands.py:85`）——

1. 把 query 发给 **本机 BGE-M3 服务 `http://127.0.0.1:18080/embed`**（`normalize=true`）；
2. `ORDER BY pe.embedding <=> $1::halfvec(1024) ASC LIMIT 60` 取最近的 60 个 chunk；
3. 按 `pageVersionId` 去重取前 6；
4. 回 join `PageVersion` 取 title/rating/tags **与 `textContent`**；
5. snippet = `textContent[chunkCharStart:chunkCharEnd]` 截到 140 字。

> ⚠️ **第 5 步是 v1 的结构性 bug**，第 4 节量化。
> ⚠️ 另外：`18080` 端口在 2026-07-27 实测**没有监听**（`ss -ltnp` 无该端口，
> `curl` 空响应；8080 上跑的是 qqbot 自己）。也就是说 **`/sem` 命令当前是坏的**，
> 与要不要重算无关，但排 v2 上线顺序时得知道。

### 1.2 embedding 的输入文本到底是什么

`PageEmbedding` 的**生成脚本已经不在磁盘上**（一次性跑完就没留），所以参数是从
生产库的 `chunkCharStart/chunkCharEnd` **逆向**出来的，逆向结果全部经实测确认：

**归一化**（三步，缺一步长度就对不上）：

```
norm = text.strip()                     # 首尾空白
norm = re.sub(r'\n{3,}', '\n\n', norm)  # 3+ 连续换行 → 2
norm = re.sub(r'[ \t]{2,}', ' ',  norm) # 2+ 连续空格/制表 → 1
```

**分块**：定长滑窗，**窗口 1500 字符 / 步长 1300（重叠 200）/ 最多 16 块**。

验证：随机 500 个有 embedding 的 pageVersion，用上式算 `len(norm)` 与预测 chunk 数，
对比生产库真实 `max(chunkCharEnd)` 与 `chunkTotal` ——

- **468/494 = 94.7% 完全相等**（另 6 行 `textContent` 为 NULL 或空白，不参与）；
- 不相等的 26 行偏差是**双向**的（14 行现在更长、12 行更短，|Δ| 中位数 24 字符、最大 1,616），
  说明不是模型错，而是 **2026-04 生成 embedding 之后 `textContent` 又被同步器覆盖过** → 见 §4。

在本文的 100 页样本上（`experiments/extract-vs-crom.ts` 的【4】节），
分块模型对真实 `chunkCharEnd` 的复刻是 **100/100 完全吻合**。

**没能逆向出来的一处**：`sourceCharLen` 恒大于 `chunkCharEnd - chunkCharStart`，
差值在页内恒定、跨页 9–341 字符（275 种取值），显然是每个 chunk 前面拼了一段
页面元数据前缀（title / alternateTitle / tags 的某种模板），但线性回归拟不出
准确形状。**对本决策无影响**：该前缀由元数据决定，换正文来源不会改变它。

### 1.3 死代码：`SearchIndex` / `SearchChunk` / `EmbeddingService`

`backend/src/services/EmbeddingService.ts`（439 行）描述的是**另一套**、
**从未在生产库存在过**的系统：

| 它说的 | 生产库实际 |
|---|---|
| 模型 `sentence-transformers/gte-multilingual-base`，dim **768**，fastembed + python stdin JSON 协议 | `BAAI/bge-m3`，dim **1024**，本机 TEI HTTP |
| 写 `SearchChunk`（带 content/tokens/lang 列） | `to_regclass` = **NULL**，表不存在（`backend/scripts/drop-search-tables.ts` 删掉的） |
| 页级平均向量写 `SearchIndex` | `to_regclass` = **NULL** |
| `EmbeddingModel` 注册表 | `to_regclass` = **NULL** |
| 调 `hybrid_search()` / `check_embedding_coverage()` | 两个函数在 `pg_proc` 里**都不存在** |

而且 `EmbeddingService` / `HybridSearchService` 在 `backend/src` / `bff/src` /
`frontend` 里**没有任何引用**（grep 全空）；`HybridSearchService` 自己的注释就写着
`Deprecated ... no-op now`，所有方法 return 空。BFF 里唯一命中 "embedding" 的
`html-snippets.ts:314` 说的是 `X-Frame-Options`，跟向量无关。

→ **`SearchIndex` / `SearchChunk` 不做一比一搬迁。** 页级平均向量（chunk 向量取平均）
在 v1 里既没被任何读路径用过，本身也是公认会把长文档"平均成一团糊"的做法；
`SearchChunk` 的职责由 `serve.text_chunk` 承担。

---

## 2. 实测：CROM 渲染文本 vs 我方 `extractTextContent(html)`

### 2.1 方法

- **样本**：100 个当前态、未删除、有 `textContent` **且有 PageEmbedding 行**的页面，
  按正文长度分 5 层各 20 页（<1.5k / 1.5–4k / 4–10k / 10–21k / >21k 字符）。
- **抓取**：整页 HTML，走 `http://127.0.0.1:7891`，带 `SYNCER2_USER_AGENT` + `Referer`
  （实测硬契约，见 `src/http/client.ts`）。**共 101 次请求**（1 次探针 + 100 页），
  在 120 的预算内；HTML 全部落盘缓存，后续所有迭代都是离线的。
- **提取**：`src/content/extractText.ts`（本轮新写的零依赖扫描器，见 §3）。
- **差异度量**：字符级 Levenshtein 在 20k 字符上是 4×10⁸ 次操作/页，不可行。
  改用**行级 LCS + 未匹配行的字符数**：
  `差异率 = (仅 v1 有的行字符数 + 仅我方有的行字符数) / (len_v1 + len_ours)`。
  两个口径各算一遍：
  - **raw**：行原样比 → 含空白策略差异，是切换后**实际**看到的差异；
  - **semantic**：两侧都先剥掉行内全部空白 → 只剩真正的内容增删。

### 2.2 字符级差异率分布

| 口径 | min | p10 | p25 | **p50** | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|---|
| raw | 0.00% | 0.00% | 0.00% | **0.65%** | 3.73% | 12.09% | 21.83% | 97.61% |
| semantic | 0.00% | 0.00% | 0.00% | **0.00%** | 0.19% | 2.55% | 5.89% | 98.46% |

semantic 分桶：

| 差异率 | 页数 |
|---|---|
| = 0（逐字相同） | **52** |
| 0–1% | 34 |
| 1–5% | 8 |
| 5–10% | 1 |
| 10–30% | 3 |
| > 30% | 2 |

**正文体量**：剥空白后合计 v1 1,066,354 字 → 我方 1,024,102 字（**−4.0%**），
比值 p25–p95 = 1.000–1.021。少掉的 4% 几乎全部来自两页极端值（§2.4）和
`[[code]]` 块（§3.2）。

→ **语义层面 86% 的页差异 ≤1%，一半逐字相同。** 单看这个数，D9 里"差异 <10% 则不重建"
的判据是满足的。但下一节说明为什么它不能作为判据。

### 2.3 分块边界变化 —— 决定性的那一节

| 指标 | 值 |
|---|---|
| v1 chunk 总数 → 我方 | 699 → 675（−24） |
| chunk **数**发生变化的页 | 9 / 100 |
| 同 index 上内容**逐字符相等**的 chunk | **2 / 699 = 0.29%** |
| 同 index 上剥空白后相等的 chunk | 20 / 699 = 2.86% |
| v1 chunk 内容能在我方**任意位置**找到的 | 2 / 699 = 0.29% |
| **⇒ 内容会变的 chunk** | **697 / 699 = 99.71%** |
| 全页 chunk 一个都没变的页 | 2 / 100 |

原因是结构性的，与差异大小无关：**分块是纯字符定长滑窗，没有任何语义锚点。**
正文第 10 个字符多一个空格，第 2 块就从 1300 挪到 1301，此后每一块的内容全变。
52 页"semantic 差异 = 0"里只有 2 页的 chunk 真的没变 —— 其余 50 页的差异
全在空白策略上，而空白同样占字符位。

> 这条也顺带否掉了另一个方案："保留 v1 向量、只对差异大的页重算"。
> 差异小的页的 chunk 边界照样全变，保留下来的向量对应的是**已经不存在的文本切片**，
> 而 snippet 又是按偏移从当前文本切的 → 检索命中的和展示给用户的不是同一段话。

### 2.4 两个硬缺口（我方漏抓，不是 CROM 噪声）

| pv | slug | v1 独有 | 我方 | 原因 |
|---|---|---|---|---|
| 16918 | `scp-3493` | 12,539 字 | **0** | 整页正文在 `[[html]]` 块里 → `<iframe src="/scp-3493/html/<hash>">`，是**另一个文档**，需要第二次 HTTP |
| 22686 | `scp-cn-2024` | 28,344 字 | 153 | 同上（`/scp-cn-2024/html/<hash>`），另外 v1 那 28k 字里前 4,034 字是 interwiki iframe 的 **JavaScript 源码** |

`class="html-block-iframe"` 在 100 页里出现于 **3 页**（1 / 1 / 7 个块）——
约 **3% 的页面**需要这条二次抓取链路。CROM 显然做了（它的 textContent 有那些内容）。

**这是 `extractTextContent` 的已知未覆盖项，不是 embedding 决策的变量**，但必须在
正文提取上线前补：不补的话这 3% 的页面在语义检索里等于不存在。
成本是每个 `[[html]]` 块一次额外 GET（URL 直接写在 iframe 的 src 上，无需猜）。

### 2.5 被误认为差异、实际是"v1 已经过期"的部分

用 difflib 逐行看了 semantic 差异率最高的几页，剩下的大头**不是提取器的问题**：

- **pv=23701（sem 17.4%）**：差异是**页面真的被改过**了 ——
  「错误的回路」→「错误的**神经**回路」、「正是因为」→「正因为」、
  「导致了我们人类的诞生」→「导致了我们的诞生」，还有整段新增/删除。
  v1 的 `textContent` 是旧版本。
- **pv=18853（sem 10.9%）**：v1 里有 `+ Show component code / - Hide component code`
  两行，而当前 HTML 里**根本没有** "component code" 这个字符串 —— 那个折叠块已被删。
- **pv=13375 / 33163**：v1 独有内容是
  `"use strict"; // Expose identity for interwikiFrame ...` —— interwiki styleFrame 的
  **JS 源码**。CROM 把它当正文收了，我们没有。这是 v1 的噪声，不是我们的缺失。

→ 也就是说 §2.2 那张分布表里，**差异的一部分是 v1 数据本身过期**，
另一部分是**我方比 CROM 干净**。真正"我方漏内容"的只有 §2.4 那两页。

---

## 3. `extractTextContent(html)` 原型

`src/content/extractText.ts`，零依赖手写扫描器（**刻意不用 cheerio**：它是
`@ukwhatn/wikidot` 的传递依赖、没写进本包 `package.json`，把摄入热路径压在
未声明的传递依赖上等于埋雷）。单遍 O(n)，只做四件事：定位 `#page-content` 子树、
按 class/id 剪区域、块级元素转换行、HTML 实体解码。

### 3.1 CROM 的提取规则是**实测反推**的

对每个结构统计「HTML 里有它的页数 → 其中 v1 `textContent` 含它文字的页数」：

| 结构 | 有该结构 | v1 含其文字 | 判定 |
|---|---|---|---|
| `.page-rate-widget-box`（"评分: +2655"） | 58 | 2 | CROM **剪掉** |
| `.licensebox` | 19 | 5 | CROM **剪掉** |
| `.footer-wikiwalk-nav`（`« SCP-3683 \| … »`） | 48 | 2 | CROM **剪掉** |
| `<div class="code">`（`[[code]]` 块，按块内文本比） | 8 | **0** | CROM **剪掉** |
| `#breadcrumbs` | 17 | 1 | 本就在 `#page-content` 外 |
| `.footnotes-footer`（脚注区，按块内文本比） | 46 | **46** | CROM **保留** |
| `#u-credit-view`（"著作信息"模态框，含隐藏内容） | 22 | 21 | CROM **保留** |
| `ul.yui-nav`（tab 标签栏，按标签文字比） | 8 | **8** | CROM **保留** |
| `.collapsible-block-folded` 的 `+ 标签` | — | 43 | CROM **保留**（folded/unfolded 两个标签各出现一次） |

加 `.footer-wikiwalk-nav` 一条规则：semantic 差异 = 0 的页 34 → **50**。
再加 `div.code` 一条：50 → **52**，p90 从 5.89% → **2.55%**。

### 3.2 与 CROM 的两处**刻意**偏离

**D-A. 折叠空白。** CROM 的输出**不折叠 HTML 源码缩进** —— 实测 pv=27005 的
`textContent` 开头逐字节是
`'著作信息\n\n\n\n\n\n    \n        \n        \n        \n'`，
那是 HTML 里的缩进被原样搬了过来。我方 `normalizeExtracted()`：
NBSP/零宽字符归一 → 行内空白压成单空格 → 逐行 trim → 连续空行压到一个 → 首尾 trim。
理由：那些空白对 embedding 与 quotes 都是纯噪声，而且**会占掉定长分块窗口的额度**
（1500 字符的窗口里塞进几十个纯空白行 = 白扔几十个字符的语义容量）。
代价：与 v1 逐字符比较必然大面积不等 —— §2.2 的 raw 与 semantic 两列差距就是它。

**D-B. `[[code]]` 块剪掉。** 与 CROM 一致（实测 0/8），但值得单独说：主题组件的
CSS/JS 动辄上千字符，是 embedding 的纯噪声。已知风险：`code` 是很泛的 class 词元，
理论上可能误伤第三方组件；本轮 100 页样本无误伤。

### 3.3 实测抓出的一个真 bug：UTF-16 vs 码点

把 100 页真实抽取结果切块灌进 `serve.text_chunk`（约束全开）时，
675 条里 **26 条**违反 `tc_content_len`（`length(content) <> char_end - char_start`）。

原因：**JS 的 `length`/`slice` 按 UTF-16 码元计数，Postgres 的 `length()`/`substr()`
按码点计数。** 语料里只要出现一个代理对（emoji、CJK 扩展 B 区生僻字，SCP 中文站里
相当常见），两边的"字符位置"就永久错开 —— 而 `char_start/char_end` 正是要拿去
在 SQL 侧 `substr()` 的。v1 没这个问题纯属侥幸：它的分块器是 Python 写的，
`str` 索引本来就是码点。

修法：`chunkLikeV1()` 改为先 `Array.from()` 拆成码点数组再按下标切，
并导出 `codePointLength()`。修完重跑：**mismatch 0 条，675 条全部插入成功**。

> 这条值得记一笔方法论：这个 bug 不可能靠读代码发现，也不可能靠合成数据发现
> （合成的中文测试串里不会有代理对）。它是**"约束写严 + 真语料灌进去"**这两件事
> 同时做才暴露的。v1 那张表一条 CHECK 都没有，所以同类问题在 v1 里是静默的
> （`sourceCharLen` 与区间长度常年不等，没人发现）。

---

## 4. v1 现状的三个量化缺陷（重算决策的真正理由）

### 4.1 偏移指向可变文本 → snippet 会切错位

`PageEmbedding.chunkCharStart/chunkCharEnd` 是 `PageVersion.textContent` 的字符偏移，
而 `textContent` 会被同步器**就地覆盖**（`PageVersion` 不是 append-only）。
实测 500 页抽样中 **26 页（26/494 = 5.3%）**的偏移已经和当前 `textContent` 对不上
（双向偏差：14 页现在更长、12 页更短，|Δ| 中位数 24 字符、最大 1,616）。qqbot 的 `semantic_search()` 按这些偏移切 snippet，
切出来的是**错位的文本**：命中的是旧文本的第 3 块，展示的是新文本第 3 块的位置。

### 4.2 没有任何增量机制

grep 全仓：**没有任何代码写入 `PageEmbedding`**（只有 qqbot 在读）。
`createdAt` 的取值范围是 `2026-04-21 17:41` → `2026-04-22 16:50` ——
一次性生成，之后**再没更新过**。因此：

| 指标 | 值 |
|---|---|
| 当前态且有正文的 pageVersion | 38,087 |
| 有 embedding 的 pageVersion | 36,160 |
| **当前态却从来没有向量的页** | **6,142（16.1%）** |
| **有向量但版本已非当前版本（`validTo IS NOT NULL`）** | **4,120** |

也就是说，即便完全不动 v2，这个索引也已经烂了 16%。

### 4.3 `sourceTruncated` 全库说谎

`sourceTruncated` 在 124,955 行里**全为 false**。
而 `max(chunkCharEnd) = 21000` 正好是 16 块的覆盖上限
（`1500 + 15×1300`），实测 **1,029 个当前态页的正文超过 21,000 字符** ——
上千页的尾部内容被静默丢弃，而标记位说没丢。

`0008` 里把它变成可约束的：`page_semantic.truncated` 由分块器写、
`text_chunk` 的 `chunk_index < chunk_total` 与 `length(content) = char_end - char_start`
两条 CHECK 兜底，写错会被数据库拒绝（§3.3 已经拒了一次真的）。

---

## 5. 决策

### 5.1 全量重算一次（切换时）

**不选"不重算"**：v1 向量对应的是旧文本的旧切片，99.71% 的 chunk 边界要变，
留着会让"命中的段落"与"展示的段落"系统性错位（§2.3 + §4.1）。

**不选"只对变更页增量"**：在切换时刻，**所有**页的正文来源都换了
（CROM 渲染文本 → 我方 `extractTextContent`），所以"变更页" = 全部页。
增量机制当然要建（`serve.embedding_backlog` 视图 + `page_semantic.text_sha`），
但它是**切换之后**的常态机制，不是切换本身的方案。

**成本（实测基线，不是估算）**：

| 项 | 值 | 依据 |
|---|---|---|
| 吞吐 | **92.2 chunk/min**（p50 96、p90 104、峰值 328/min） | v1 那轮 1,355 个有生成活动的分钟 / 124,955 chunk |
| 硬件 | CPU-only，Intel Xeon Gold 6248 × 80 线程，**无 GPU**（`nvidia-smi` 不存在） | 本机实测 |
| 服务 | 自托管 BGE-M3（TEI，`127.0.0.1:18080`） | `queries.py:741` |
| **API 费用** | **0 元** | 自托管，不经任何计费端点 |
| v2 全量规模 | 38,087 页 → **≈128,000 chunk**（v1 分块模型算出 133,706，我方正文短 4% ⇒ ≈128k） | 生产库全量算 |
| **墙钟** | **≈23.1 小时**（128,000 / 92.2 min） | 上两行 |
| 文本量 | ≈176 M 字符 | 128k × 均 1,373 字符 |

> 如果哪天改成外包给云端 embedding API：176 M 字符 ≈ 120–176 M token
> （BGE-M3 用 XLM-R tokenizer，中文约 1–1.5 字符/token），按 $0.02/M token 量级
> ≈ **US$2.4–3.5**。也就是说**钱从来不是这个决策的变量**，唯一的变量是那 23 小时。

**排期建议**：
1. 23 小时可以完全避开切换窗口 —— 向量表与主库无关，**可以在切流前就在 scpper-v2 上跑完**，
   前提是 v2 的正文（`page_current.search_text` / `content_blob.text_content`）先落地。
2. 分两批：先算 rating ≥ 0 的当前态页（覆盖 `/sem` 的绝大多数命中面），
   再补其余 + 已删页。`serve.embedding_backlog` 视图天然支持这种分批
   （`reason='missing'` + 自定义 ORDER BY）。
3. **重算前必须先补 §2.4 的 `[[html]]` 块二次抓取**，否则那 3% 的页面会带着空正文
   进索引，等补完又要重算一遍。

### 5.2 顺带修掉的三件事

| v1 | v2（0008） |
|---|---|
| 偏移指向可变的 `PageVersion.textContent` | 键换成 **`text_sha` = sha256(归一化正文)**，内容寻址；同文本共享一份切片与向量 |
| chunk 不存正文，靠回切全文 | `text_chunk.content` 存正文（lz4），读路径自包含；**已删页 tombstone 后仍可检索** |
| 分块参数硬编码在一个已丢失的脚本里 | `serve.text_chunker` 一行一版（v1 参数也登记了一行，供对账） |
| `sourceTruncated` 全 false | `page_semantic.truncated` + 两条 CHECK |
| 无覆盖率可查（`check_embedding_coverage()` 函数不存在） | `serve.semantic_coverage()` + `serve.embedding_backlog` 视图 |

---

## 6. 归属：四 schema 里的位置（`migrations/0008_serve_embedding.sql`）

判定依据是设计文档 §4.5 对 Tier-2 投影的定义：**不是上游事实（ingest）、
不是运维元数据（meta）、不是用户自有域（app），100% 由 `正文 + 分块参数 + 模型` 决定、
丢掉可以整表重算** → **serve**，且必须声明 `rebuild_from` 并登记
`meta.projection_cursor`（否则 `meta.projection_window()` 对未登记投影抛 `23503`）。

| 对象 | 角色 | `rebuild_from` |
|---|---|---|
| `serve.text_chunker` | 分块契约（参数即数据），2 行：`v1-fixed-1500-1300`（对账用）/ `v2-fixed-1500-1300`（活跃） | `NONE`（配置表） |
| `serve.embedding_model` | 模型注册表，`model_id smallint` 主键（不拿 64 字符的 name 进索引），唯一活跃模型由部分唯一索引强制 | `NONE`（配置表） |
| `serve.text_chunk` | 分块投影，PK `(text_sha, chunker, chunk_index)`，存 `content` | `ingest.content_blob.text_content`（或 `serve.page_current.search_text`）+ `serve.text_chunker` 参数 |
| `serve.chunk_embedding` | 向量，PK `(text_sha, chunker, chunk_index, model_id)`，复合 FK → `text_chunk`，HNSW `halfvec_cosine_ops` m=16/ef=64 | `serve.text_chunk.content` + `serve.embedding_model`（纯派生，可整表丢弃后重算） |
| `serve.page_semantic` | 页级状态：`page_id → text_sha / chunker / chunk_count / truncated / extractor / model_id`。读路径入口 + 重算驱动 | `serve.page_current.search_text` + `serve.text_chunker` + `serve.embedding_model` |
| `serve.embedding_backlog` | **视图**（零状态）：`missing / text_changed / awaiting_embedding / chunker_changed / model_changed / ok` | 派生自上面几张 |
| `serve.semantic_coverage()` | 覆盖率对账函数，替代不存在的 `check_embedding_coverage()` | — |

### 6.1 与任务 A 的登记清单冲突处理

`meta.projection_cursor` 在本文件执行时**已经有 27 行**（并行任务 A 的初始登记清单）。
0008 用 `ON CONFLICT (projection) DO NOTHING`：**谁先跑谁写入，后跑的不覆盖**。
刻意**不用 `DO UPDATE`** —— `rebuild_from` 一旦被两个迁移互相覆盖，
"注释与游标逐字一致"这条纪律就失去意义了，冲突应该由人看见并解决。

另外 `rebuild_from` **不手写字面量**，而是
`obj_description(to_regclass(...), 'pg_class')` 从注释读回来 ——
README TODO #3 想要的那条"比对 pg_class 注释与 projection_cursor.rebuild_from
是否漂移"的 CI 断言，在这里被前移成了**构造上不可能漂移**。

### 6.2 pgvector 未安装：与 0005 同一套降级哲学

`vector` 扩展在 scpper-v2 上**未安装**且需要 superuser
（实测 `CREATE EXTENSION vector` → `permission denied ... Must be superuser`；
`pg_available_extensions` 里有 0.8.3，主库 scpper-cn 已装）。

0008 把向量表单独放在 DO 块里：扩展缺失 → **跳过该段 + `RAISE WARNING` 留 TODO**，
其余（注册表 / 分块 / 页级状态 / backlog 视图 / 覆盖率函数 / 游标登记）照常建成。
补装后**重跑 0008 即补齐**，幂等。

```
TODO(DBA)：在 scpper-v2 上执行（需 superuser）
    CREATE EXTENSION IF NOT EXISTS vector;
  然后重跑 migrations/0008_serve_embedding.sql
  （顺带：pgroonga 装好后 0008 第 9 节会补 tc_content_pgroonga，混合检索的 FTS 侧）
```

### 6.3 存储账

实测：100 页真实语料 675 chunk，`content` 原始 2.43 MB（均 **3,601 字节/chunk**，
含 13% 窗口重叠冗余），落库 `pg_total_relation_size` = **2,474 kB**（lz4）
→ 3,665 字节/chunk → 全站 128k chunk **≈ 447 MB**。
（同样 675 行在默认 pglz 下量到 4,824 kB，所以 `content SET COMPRESSION lz4` 这一步
值大约一半的体积；lz4 不可用时 DO 块只打 NOTICE 不失败。）

加上向量侧（沿用 v1 实测：halfvec(1024) TOAST ≈ 330 MB + HNSW ≈ 325 MB，
128k/125k 规模相当）→ **语义检索域总账 ≈ 1.1 GB**。
synthesis §3 说 v2 文档的"总账 10 GB → 4.5–5.5 GB"估算里
**没算 PageEmbedding**，这 1.1 GB 是它的替代品，要加进去。

---

## 7. 验证记录（都真的跑了）

| 项 | 命令 | 结果 |
|---|---|---|
| 0008 首次应用 | `psql scpper-v2 -f migrations/0008_serve_embedding.sql` | 成功；WARNING = pgvector 缺失（预期） |
| 幂等重跑 ×2 | 同上 | 两次 `exit=0`，只有 `already exists, skipping` NOTICE |
| lz4 生效 | `SELECT attcompression FROM pg_attribute …` | `l` |
| 功能冒烟 | `psql -f checks/embedding_smoke.sql` | **11 条通过 / 2 条跳过**（E10/E11 待 pgvector），末尾 ROLLBACK 无残留 |
| 真语料灌库 | 100 页 → 675 chunk `INSERT INTO serve.text_chunk` | 首轮**被 `tc_content_len` 拒 26 条**（→ §3.3 修码点 bug）；修后 **675/675 通过** |
| 分块模型复刻 | `experiments/extract-vs-crom.ts --chunks` | 对生产库真实 `chunkCharEnd` **100/100 吻合** |
| 提取健康度 | 同上【5】节 | 100 页全部定位到 `#page-content`；1 页提取为空（= §2.4 的纯 `[[html]]` 块页） |
| 类型检查 | `tsc --noEmit`（本任务两个文件） | 通过 |

冒烟断言清单（`checks/embedding_smoke.sql`，E1–E13）：
backlog 视图三种 reason 的判定、视图算的 `current_text_sha` 与 `sha256(search_text)` 相等、
`tc_content_len` / `chunk_index < chunk_total` / 未注册 chunker 三条负向断言、
`model_id` 与 `embedded_at` 必须成对、正文变更后 `reason` 翻成 `text_changed`、
唯一活跃模型、复合外键形状 + `ON DELETE CASCADE`（用替身表测，不依赖 pgvector）。

---

## 8. 留给后续的事

1. **`[[html]]` 块二次抓取**（§2.4）：`iframe.html-block-iframe` 的 `src` 直接可用，
   约 3% 页面需要。**必须在 embedding 全量重算之前做完**，否则要重算两遍。
2. **`ingest.content_blob` 的键语义**：`sha256` 是**源码**的摘要，而 `text_content` 是
   **渲染正文**（同一份源码在不同时间可能渲染出不同正文 —— include 变了、主题变了）。
   表上有 `trg_immutable` 禁 UPDATE，于是"正文重渲染"在现结构下无处落。
   0008 因此**刻意不对 content_blob 加外键**，用独立的 `text_sha` 键空间绕开；
   但 0001 那个语义含混本身该有人定夺。
3. **`extractTextContent` 的自动化测试**：目前只有 100 页的离线对比脚本，
   没有单元测试（实体解码、未闭合标签、`<script>` 里的假 `</div>`、代理对切分
   这几条都值得钉死）。归入 README TODO #11「采集层没有自动化测试」。
4. **qqbot 读路径改造**：切 v2 后 `semantic_search()` 要改成读
   `serve.chunk_embedding ⋈ serve.text_chunk`（snippet 直接取 `content`，
   不再回切全文），并且 **`127.0.0.1:18080` 的 embed 服务得先起来**（当前未监听）。
5. **`serve.chunk_embedding` 的类型验证**：E10/E11 在 pgvector 装好后要真跑一遍
   （现在只验了键形状，没验 `halfvec` 类型本身）。
