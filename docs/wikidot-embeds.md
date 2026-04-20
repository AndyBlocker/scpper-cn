# SCPPER-CN Wikidot 嵌入组件

本文档描述 scpper.mer.run 提供的三类可嵌入组件，以及它们对应的 Wikidot 组件源代码写法。所有端点挂在 `/api/embed/*`（BFF 路由模块：[`bff/src/web/routes/embed.ts`](../bff/src/web/routes/embed.ts)）。

## 设计取舍

| 维度 | 选择 | 理由 |
| --- | --- | --- |
| SVG 徽章 vs iframe | 徽章走 SVG（`[[image]]`） | 无需 Wikidot iframe allowlist，支持 `currentColor` 跟随分部主题 |
| 数据 | 全部复用现有 `PageStats` / `UserStats` / `votingTimeSeriesCache` | 无需新表；日常同步已经覆盖 |
| 自定义 CSS | 通过 URL `?css=<编码后的 CSS>` 直接注入 | 不上传文件、不服务端缓存，满足"输入即应用"的定位 |
| CSS 安全 | 拒绝 `@import` / `javascript:` / `expression(` / `</style>` 等危险片段 | 关键字黑名单 + url() 限制，不通过的 CSS 静默丢弃 |
| CSP | `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors *` | 不允许任何 `<script>`，所有交互靠纯 CSS |
| X-Frame-Options | 显式不设 | 允许被任意站点 iframe |
| Cache | badge 300s；user-card 300s；user-history 600s | 与数据实际刷新节奏一致，避免高 QPS 打爆 DB |

## 端点规格

### 1. Page Badge — SVG

```
GET /api/embed/badge/page/:wikidotId.svg
  metric = rating (默认) | wilson | controversy | votes | trend
  label  = 自定义左侧文本；省略则按 metric 派生默认值
  style  = flat (默认) | plastic | mono
  theme  = mono  (等同于 style=mono，令徽章用 currentColor 跟随父级主题)
  accent = 6/3/8 位 hex，不含 #；仅对非 trend 生效
```

- `metric=trend` 走 [`Page.votingTimeSeriesCache`](../backend/prisma/schema.prisma)，渲染**最近 90 天**累计评分 sparkline。
- 其他 metric 读 `PageStats.wilson95` / `PageStats.controversy` / `PageVersion.rating` / `PageVersion.voteCount`。
- 返回 `Content-Type: image/svg+xml`，可直接被 Wikidot `[[image]]` 引用。

### 2. User Card — iframe (HTML)

```
GET /api/embed/user-card/:wikidotId
  theme           = auto (默认) | light | dark
  accent          = hex (可带或不带 #)
  breakdown       = list (默认) | radar
  hideActivity    = 0 (默认) | 1      → 隐藏"首次活动 / 最近活动"
  showCategories  = scp,story,translation,goi,wanderers,art (任意子集)
  css             = URL-encoded 后的自定义 CSS，最大 4KB，超过会尝试截到最近的 `}`
```

显示：头像、displayName、wikidotId、`#overallRank`、总评分、平均分、作品、支持/反对票、分类表现（列表或雷达）。与前端的用户页头部字段一一对应（[`frontend/components/UserCard.vue`](../frontend/components/UserCard.vue)）。

### 3. User History — iframe (HTML)

```
GET /api/embed/user-history/:wikidotId
  theme        = auto | light | dark
  accent       = hex
  range        = 90d (默认) | 1y | all      → 评分曲线显示区间
  showTrend    = 0 | 1 (默认)               → 评分曲线
  showHeatmap  = 0 | 1 (默认)               → 近一年活动热力图
  css          = URL-encoded 自定义 CSS
```

- 评分曲线：累计 `upvotes - downvotes`，SVG 折线 + 面积。
- 活动热力图：52 周 × 7 天，`UserDailyStats.votes_cast + pages_created*3` 分 4 档。

## 用户可覆写的 CSS 变量

模板 CSS 在 `:root` 下声明以下变量，可以被 `?css=` 参数传入的 CSS 覆盖：

```css
:root {
  --e-bg: #ffffff;          /* 卡片背景 */
  --e-surface: #f7f7f8;     /* 次级面 */
  --e-border: #e5e7eb;      /* 边框 */
  --e-text: #111827;
  --e-text-muted: #6b7280;
  --e-text-subtle: #9ca3af;
  --e-accent: #6f4ef2;      /* 可被 accent= 覆盖；也可被自定义 CSS 覆盖 */
  --e-accent-soft: ...;     /* accent 的半透明软色 */
}
```

只改颜色时最稳妥的写法是只覆盖变量，而不是动 CSS 规则本身：

```css
:root { --e-accent: #ff3b30; --e-bg: #fff8f4; }
.e-card { border-radius: 6px; box-shadow: 0 0 0 2px rgba(0,0,0,.06); }
```

## Wikidot 组件源代码

### component:scpper-badge

SVG 徽章 — 用 `[[image]]` 不需要 iframe allowlist。

```
[[div_ class="scpper-badge-wrap"]]
[[image https://scpper.mer.run/api/embed/badge/page/{$page_id}.svg?metric={$metric}
  alt="SCPPER 统计徽章"
  class="scpper-badge"
  style="vertical-align:middle"
  link="https://scpper.mer.run/page/{$page_id}"]]
[[/div]]

[[module CSS]]
.scpper-badge { height: 20px; vertical-align: middle; }
.scpper-badge-wrap { display: inline-block; }
[[/module]]
```

Hub/目录页可以在每个 SCP 后缀徽章，批量用法：

```
||~ 编号 ||~ 名称 ||~ 评分 ||~ Wilson ||
|| [[[scp-cn-2000]]] || 不死鸟计划 || [[image https://scpper.mer.run/api/embed/badge/page/1306943399.svg?metric=rating]] || [[image https://scpper.mer.run/api/embed/badge/page/1306943399.svg?metric=wilson&theme=mono]] ||
```

`theme=mono` 让徽章用 `currentColor`，SCP-CN 白夜模式切换时徽章会跟着变色。

### component:scpper-user-card

iframe 方案，需要分部把 `scpper.mer.run` 加入 `_meta:iframe-security` 的允许列表（或站点 CSS 的 `iframe-src` 白名单）。

```
[[module CSS]]
.scpper-embed-frame {
  width: 100%;
  min-height: 320px;
  border: none;
  display: block;
}
[[/module]]

[[iframe https://scpper.mer.run/api/embed/user-card/%%created_by_unix%%?theme=auto&breakdown=list
  class="scpper-embed-frame"
  frameborder="0"
  scrolling="no"]]
```

> `%%created_by_unix%%` 是 Wikidot 占位符，渲染时替换为当前页作者的 wikidotId；也可以写死一个数字。

**传入自定义 CSS（整版红色主题示例）：**

```
[[iframe https://scpper.mer.run/api/embed/user-card/1546989?theme=dark&accent=ff3b30&css=%3Aroot%7B--e-bg%3A%23150606%3B--e-surface%3A%23240a0a%3B--e-border%3A%23421717%3B%7D%0A.e-card%7Bborder-radius%3A4px%3B%7D%0A.e-rank%7Btext-shadow%3A0%200%200%20%23ff3b30%7D
  class="scpper-embed-frame"
  frameborder="0"
  scrolling="no"]]
```

对应的原始 CSS 是：

```css
:root {
  --e-bg: #150606;
  --e-surface: #240a0a;
  --e-border: #421717;
}
.e-card { border-radius: 4px; }
.e-rank { text-shadow: 0 0 0 #ff3b30 }
```

用任意 URL-encoder 处理后拼到 `css=` 后面即可；URL 超过 4KB 时服务端会把超出部分安全截断。

### component:scpper-user-history

```
[[module CSS]]
.scpper-embed-frame-tall {
  width: 100%;
  min-height: 460px;
  border: none;
  display: block;
}
[[/module]]

[[iframe https://scpper.mer.run/api/embed/user-history/%%created_by_unix%%?range=1y&theme=auto
  class="scpper-embed-frame-tall"
  frameborder="0"
  scrolling="no"]]
```

典型使用场景：作者自己的 `user:info` 页底部、作者列表页。

### Fallback：通过分部 wdfiles 做 frame-shell

如果分部管理员短期内不愿意把 `scpper.mer.run` 加到 iframe allowlist，可以学 `scpwiki/interwiki` 的做法：把下面这个薄 HTML 传到 `component:scpper-frame` 的 `wdfiles`，用 `[[iframe]]` 指向自家 wdfiles，由 wdfiles 里的页面再 iframe 到 scpper.mer.run。

`frame.html`（传到 wdfiles）：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>html,body{margin:0;padding:0;background:transparent}iframe{border:none;width:100%;display:block}</style>
</head>
<body>
<script>
  const p = new URLSearchParams(location.search);
  const kind = (p.get('kind') || '').replace(/[^a-z\-]/g, '');
  const wid  = (p.get('wid')  || '').replace(/[^0-9]/g, '');
  if (!/^(user-card|user-history)$/.test(kind) || !wid) {
    document.body.textContent = 'invalid params';
  } else {
    p.delete('kind'); p.delete('wid');
    const q = p.toString();
    const iframe = document.createElement('iframe');
    iframe.src = 'https://scpper.mer.run/api/embed/' + kind + '/' + wid + (q ? '?' + q : '');
    iframe.width = '100%';
    iframe.setAttribute('scrolling', 'no');
    // 静态高度；若需要自适应，可以在这里加一个 postMessage 监听
    iframe.height = kind === 'user-history' ? 520 : 360;
    document.body.appendChild(iframe);
  }
</script>
</body>
</html>
```

Wikidot 组件里 iframe 到自家 wdfiles：

```
[[iframe http://scp-wiki-cn.wdfiles.com/local--files/component%3Ascpper-frame/frame.html?kind=user-card&wid=%%created_by_unix%%&theme=auto
  frameborder="0" width="100%" height="360" scrolling="no"]]
```

## 常见坑

1. **Wikidot `[[iframe]]` 的 allowlist**：管理员需要在 `_meta:iframe-security` 或 `.w-site-css` 里放行 `scpper.mer.run`。不放行时浏览器会静默拒绝加载 iframe（控制台有 CSP 报错）。
2. **CSS URL-encoding 失误**：Wikidot `[[iframe]]` 对 URL 不做二次转码；`?` `&` `#` 本身不需要编码，但 CSS 内容里的 `{`、`:`、空白、换行必须编码。推荐用脚本/浏览器控制台 `encodeURIComponent(css)` 先处理一次。
3. **自定义 CSS 被整块丢弃**：只要 CSS 里命中任意一条黑名单（`@import` / `javascript:` / `expression(` / `</style>` 等），整段 `css=` 就会被忽略而非只剥离那一条。这是刻意为之——解析一半的 CSS 反而更难排错。
4. **头像 404 不是 bug**：一些用户在 Wikidot 上没头像，avatar-agent 会回落到默认图或 404；模板里 `<img onerror>` 会把占位藏掉。
5. **Wilson 95% 对低样本敏感**：页面票数 < 30 时 `wilson95` 可能会显著低于直觉，徽章会照实显示。如果想过滤低票页面，在源码里自己判断 `voteCount` 再渲染徽章即可。

## 数据来源对照表

| 组件字段 | 来源 |
| --- | --- |
| `metric=rating` / `votes` | `PageVersion.rating` / `.voteCount`（`validTo IS NULL` 版本） |
| `metric=wilson` / `controversy` | `PageStats.wilson95` / `.controversy` |
| `metric=trend` sparkline | `Page.votingTimeSeriesCache.upvotes/downvotes` 末尾 90 天 |
| User card 评分 / 作品 / 分类 | `UserStats.*`（与 `/api/users/:id/stats` 同源） |
| User history 评分曲线 | `User.attributionVotingTimeSeriesCache` |
| User history 热力图 | `UserDailyStats.votes_cast + pages_created`（近 366 天） |
| 头像 | `/api/avatar/:wikidotId`（走现有 avatar-agent 代理） |
