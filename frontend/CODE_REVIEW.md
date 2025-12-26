# 前端代码审查要点（重点问题与改进建议）

## 安全
- `frontend/layouts/default.vue`（桌面/移动搜索联想）与 `frontend/components/PageCard.vue`（搜索结果卡片）直接对后端返回的 `snippet` 做 `v-html` 渲染，未做净化，存在 XSS 风险。**建议**：前端引入轻量净化（如 DOMPurify，仅允许安全标签），或在 BFF/后端统一清洗 snippet，再在前端按纯文本兜底。

## 交互与体验
- `frontend/pages/search.vue:535-545`：表单“重置”未恢复 `scope`，Segmented 控件会变成无选中状态，逻辑却默认 both，易造成误解。**建议**：重置时同时设回 `scope='both'` 并更新 URL/状态。
- `frontend/pages/search.vue:581-781,900-963`：搜索请求缺少竞态防护，快速输入/切换条件时旧请求返回会覆盖新结果与缓存。**建议**：为 `fetchUsers`/`fetchPages` 增加请求序号或 AbortController，丢弃过期响应；`Promise.all` 处也应检测当前参数。
- `frontend/pages/index.vue`：站点总览加载失败或延迟时直接显示 0，缺少 skeleton 或错误态，易误导用户。**建议**：增加加载骨架、错误提示并避免用 0 作为占位值。

## 可访问性 / 移动体验
- `frontend/layouts/default.vue`：移动搜索浮层与侧边栏缺少焦点陷阱与 modal 语义，开启后 Tab 仍可落到背景，关闭后也不回焦触发按钮。**建议**：为移动浮层添加 `role="dialog"`、`aria-modal`、焦点循环与关闭回焦逻辑，并在打开时锁定背景滚动。

## 其他潜在优化
- `frontend/components/PageCard.vue` 使用的 snippet 也来自后端，若后端未净化同样受 XSS 影响，可与上文安全项统一处理。

> 上述项为本次通读 `frontend/` 目录全部代码后的主要问题与改进路径，建议优先级：安全 > 交互稳定性 > 体验/无障碍。
