# Development Workflow

## Goals

- `main` 只承载可部署代码。
- PM2 始终绑定受保护的生产 checkout，不直接跑开发 worktree。
- 日常开发、`npm run dev`、本地构建都默认落在 feature worktree 和隔离端口上。
- 所有改动经由 PR 合并，合并前至少完成一次 Codex review 和一次 Claude Code review。

## Checkout Roles

### 1. 受保护生产 checkout

- 路径：当前仓库主目录 `/home/andyblocker/scpper-cn`
- 分支：`main`
- 用途：PM2 运行、合并后的生产构建、部署
- 禁止事项：
  - 直接在这里开发功能
  - 直接在这里提交 `main`
  - 直接在这里跑日常 `dev/build/start`
  - 直接在这里执行会修改生产数据的开发实验

### 2. 开发 worktree

- 默认路径：`../scpper-cn-worktrees/<branch>`
- 分支：`feat/*`、`fix/*`、`refactor/*`、`docs/*`、`chore/*`、`hotfix/*`
- 用途：Codex、Claude Code、本地调试、测试、提交 PR

创建方式：

```bash
bash scripts/dev-worktree.sh create feat/<topic>
```

脚本会：

- 基于 `origin/main` 创建或复用 branch
- 创建独立 worktree
- 尝试复制各服务现有 `.env` 到新 worktree，避免手工重配
- 不复制 `node_modules`；已接入 wrapper 的命令会在缺少本地依赖时临时复用受保护 checkout 的已安装依赖
- 如果目标服务的依赖清单有变化，或你需要完全独立的依赖树，再在对应目录执行 `npm install`

## Branching Rules

- 禁止直接在 `main` 开发。
- 一个需求一个 branch，不混写多个主题。
- 命名建议：
  - `feat/<topic>`
  - `fix/<topic>`
  - `refactor/<topic>`
  - `docs/<topic>`
  - `chore/<topic>`
  - `hotfix/<topic>`

## Daily Flow

1. 在受保护 checkout 执行 `bash scripts/install-hooks.sh`，只需一次。
2. 新任务开始前执行 `bash scripts/dev-worktree.sh create feat/<topic>`。
3. `cd` 到新 worktree 后再运行开发命令。
4. 先直接运行已接入 wrapper 的命令；如果某个服务脚本仍依赖本地 `node_modules`，或者依赖本身有变化，再在对应目录执行 `npm install`。
5. 在 feature branch 提交，推送并开 PR。
6. PR 上先做自动/人工检查，再做双 agent review。
7. 合并后回到受保护 checkout，同步 `main`，再部署给 PM2。

## Local Dev Isolation

开发脚本现在默认使用隔离端口，避免撞到生产 PM2：

- Frontend: `19876`
- BFF: `14396`
- User Backend: `14455`
- Avatar Agent: `13200`
- Mail Agent: `13110`

额外隔离：

- Frontend 的 BFF proxy 不再写死 `4396`，改为读取 `BFF_PROXY_TARGET`
- Avatar Agent 开发默认写入 worktree 自己的 `.data/avatar-agent-dev/`
- BFF 开发默认 `ENABLE_CACHE=false`，避免污染生产 Redis

如果确实要在生产 checkout 执行构建/启动，必须显式带上：

```bash
SCPPER_ALLOW_PROTECTED=1 <command>
```

这只用于部署或紧急修复，不用于日常开发。

## PR Rules

- 所有代码改动必须通过 PR 合并到 `main`
- 禁止直接 push `main`
- PR 至少包含：
  - 改动摘要
  - 验证方式
  - 风险/回滚说明
  - `Codex review` 结果
  - `Claude Code review` 结果

仓库提供了 [`.github/pull_request_template.md`](/home/andyblocker/scpper-cn/.github/pull_request_template.md)。

## Agent Review Rules

合并前必须完成交叉审核：

1. 让 Codex 审查 branch diff / PR diff
2. 让 Claude Code 审查同一份 diff
3. 先解决高优先级问题，再合并

审核关注点统一为：

- bug
- 回归风险
- 边界条件
- 缺失测试
- 迁移 / 配置 / 部署风险

## Deployment Rules

- 只从受保护生产 checkout 部署
- 只部署已经合并到 `main` 的代码
- PM2 继续指向生产 checkout 的 `dist` / `.output`
- 不把 PM2 指向任意 feature worktree

推荐顺序：

1. 在生产 checkout 同步 `main`
2. 按服务重新构建
3. `pm2 reload <service>`
4. 检查日志和健康检查

## Agent Obligations

仓库级 agent 规则写在：

- [AGENTS.md](/home/andyblocker/scpper-cn/AGENTS.md)
- [CLAUDE.md](/home/andyblocker/scpper-cn/CLAUDE.md)

Codex 和 Claude Code 都应遵守以下默认动作：

- 发现当前在 `main` 时，先切到 feature worktree，再写代码
- 未完成 PR 和双 review 前，不建议合并或部署
- 未显式授权前，不在生产 checkout 跑开发命令
