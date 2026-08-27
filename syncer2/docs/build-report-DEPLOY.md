# syncer2 显式发布改造报告（DEPLOY）

日期：2026-08-27（Asia/Shanghai）  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
基线提交：`91c93e9`  
结论：发布机制已实现并通过静态/隔离验证；**首次生产发布被既有 v2 schema/check 漂移门禁阻断，已恢复工作树直跑，未发布快照。**

## 1. 实现

布局：

```text
~/syncer2-releases/
├── current -> 20260827T...Z-<git-sha12>  # 单次 rename 原子翻转
├── shared-state/                         # 跨发布的 L1/sitemap 基线
├── deployments.jsonl                    # deploy/rollback 操作日志
├── ops-backups/                          # 首次切换前的本机 override
└── <timestamp>-<sha12>/
    ├── src/ ...
    ├── node_modules/                     # 本快照 npm ci，独立 inode
    ├── state -> ../shared-state
    ├── .env                              # 0600
    ├── DEPLOYMENT.json
    └── DEPLOY-GATES.log
```

每个快照运行 `npm ci`，没有采用 `rsync --link-dest` 硬链 `node_modules`。代价是每版约
154 MiB 且发布稍慢；收益是后续 `npm install`/包脚本不能原地修改旧版依赖，rollback
仍是完整可复现版本。默认保留 5 个快照（环境变量可改，但拒绝小于 3）。

`deploy/deploy` 的顺序固定为：同一门禁全绿 → rsync 源码 → 快照内 `npm ci` →
`incremental-scan.ts --help` 启动校验 → 写发布元数据 → 原子翻转 `current` → 追加 JSONL
日志 → 保留策略。脚本和门禁均未引用 `migrations/apply.sh`，日志固定记录
`migrations_applied:false`。

`deploy/rollback` 默认翻到当前版本前一个时间戳快照，`--to latest` 或 `--to <name>` 可
显式翻前；同样只做原子链接替换，不 restart oneshot。

## 2. 门禁与钩子

唯一入口是 `deploy/run-gates.sh`：

1. 只接受 `localhost:5434/scpper-v2` 目标；
2. `npx tsc --noEmit`；
3. `npm test`；
4. `checks/run_checks.sh` 的全部 numbered SQL checks；
5. `checks/[0-9]*.sh` 的全部 numbered shell checks。

测试与 SQL checks 明确依赖部署机端口 5434 的 v2 活库，不 skip。`.githooks/pre-push`
在原有 main/master guard 后执行同一入口；`deploy/install-pre-push-hook.sh` 安装，
`checks/0008_pre_push_hook.sh` 同时检查 `core.hooksPath=.githooks`、可执行位和真实接线。
`git push --no-verify` 仅作为生产紧急逃生。

`checks/0004_systemd_sync.sh` 仍逐文件核对仓库与安装态，又增加三层断言：repo 模板、
任意 base override、systemd 合并后的 l1 都必须指向 `syncer2-releases/current`，并拒绝
`scpper-cn-worktrees` / 工作树源码直跑。

## 3. 首次切换实测与自动回退

切换前安装态：

```text
ExecStart=/usr/bin/env npm run schedule:l1
WorkingDirectory=/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation/syncer2
EnvironmentFiles=.../syncer2/.env
```

先把 `current` 临时桥接到上述工作树，再运行 `install-systemd.sh`。未 stop/restart 任何
timer；15/15 timer 全程 active。`daemon-reload` 后实测：

```text
ExecStart=/usr/bin/env npm --prefix /home/andyblocker/syncer2-releases/current run schedule:l1
WorkingDirectory=/home/andyblocker/syncer2-releases/current
EnvironmentFiles=/home/andyblocker/syncer2-releases/current/.env
checks/0004: systemd 定义与安装一致
```

首次 `deploy` 随后运行。类型检查通过，`npm test` 精确
`tests 595 / pass 595 / fail 0 / skipped 0`（164394 ms）；SQL checks 出现 3 组既有失败：

- `0001_projection_cursor_drift.sql`：`serve.image_asset_url_alias` 未登记到
  `meta.projection_cursor`；
- `0002_write_freeze_wiring.sql`：活库 `ingest.apply_vote_cas_batch` 定义没有直接调用
  `meta.assert_writes_allowed(...)`；
- `0005_pending_collection_coverage.sql`：6 张已存在表未登记 pending 语义：4 张
  `external_image_egress_*`、`meta.l1_absence_observation`、
  `meta.l1_partial_vote_state`。

因此 deploy exit 1，`current` 前后都保持工作树桥，没有 staging 残留、没有发布目录、
没有迁移被应用。随后用 `deploy/fallback-to-worktree.sh` 恢复原执行形态；最终实测：

```text
ExecStart=/usr/bin/env npm run schedule:l1
WorkingDirectory=/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation/syncer2
EnvironmentFiles=.../syncer2/.env
15/15 timer active
```

这是预定失败回退态，所以最终安装态的 `checks/0004` 会故意为红：仓库声明 release
模式，而生产暂时由 `99-emergency-worktree.conf` 回到工作树。修复数据库门禁后，重跑
`install-systemd.sh` 会备份该 emergency override 并恢复一致。

## 4. 负向与 rollback 验证

门禁负向：临时新增一个不会被生产入口 import、但会被 tsc 扫描的类型错误；deploy 在
4.5 秒内以 TS2322 拒绝，`current_before == current_after`，随后删除该文件且最终
`npx tsc --noEmit` 再次通过。

rollback 命令在隔离 release root 中用两个完整形状的 fixture 实测：

```text
20260827T121000Z-222222222222 -> 20260827T120000Z-111111111111
20260827T120000Z-111111111111 -> 20260827T121000Z-222222222222 (--to latest)
```

这只证明命令的原子往返逻辑；**因首次门禁未产生合格生产快照，未冒充生产 rollback
验收。** 同理没有执行工作树语法炸弹：当前已按失败策略恢复工作树直跑，此时故意破坏
生产 import 文件会真实打断 L1，与“不间断”约束冲突。发布后的三轮 L1、50/50
work-queue、forum-consume 验收也尚未开始。

## 5. 运维手册

### 解除本次阻塞后首次发布

先由 DBA/人工迁移时序修复上面三组 schema/check 漂移；**不要把迁移塞入 deploy**。

```bash
cd /home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation/syncer2
./checks/run_checks.sh
./deploy/install-pre-push-hook.sh
./deploy/install-systemd.sh
./deploy/deploy
systemctl --user show syncer2-job@l1.service -p ExecStart -p WorkingDirectory -p EnvironmentFiles
```

然后至少观察/触发三轮 L1，并核对每轮 `status=ok`、`pagesEnumerated≈36970`、86–110 秒；
核对 work-queue `claimed=50 processed=50` 与 forum-consume 正常。只有确认 `current` 已是
真实快照后，才可做工作树语法炸弹并立即还原。

### 日常发布、回滚、逃生

```bash
./deploy/deploy                    # 全门禁；失败不翻转；绝不跑 migration
./deploy/rollback                  # 回前一个保留快照
./deploy/rollback --to latest      # 验证后翻回最新
./deploy/rollback --to <快照名>    # 显式选择
./deploy/fallback-to-worktree.sh   # 首次切换失败；不停止 timer
git push                           # 同一门禁
git push --no-verify               # 仅紧急，事后必须补跑 ./deploy/run-gates.sh
```

## 6. 验收状态

| 项目 | 状态 |
|---|---|
| TypeScript / systemd 静态验证 | PASS |
| `npm test` 基线 | PASS，595/595 |
| pre-push 安装与接线检查 | PASS |
| 门禁失败不翻转 | PASS（真实 SQL 红灯 + 故意 TS 红灯） |
| 切换失败恢复工作树、timer 不停 | PASS |
| SQL checks / 最终 0004 | BLOCKED（上述 schema 漂移 + 预定 fallback 态） |
| 首次生产快照 / ExecStart=current 最终态 | BLOCKED |
| 发布后 L1×3、work-queue 50/50、forum | NOT RUN |
| 工作树语法炸弹 | NOT RUN（无合格快照，执行会伤生产） |
| rollback | fixture PASS；生产 NOT RUN |

未触碰 `/home/andyblocker/qqbot`，未发送任何 QQ 消息；未 commit、未 push。
