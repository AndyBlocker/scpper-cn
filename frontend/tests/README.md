# Account 浏览器回归

`account-refactor.smoke.cjs` 使用 Playwright 拦截 `/api/*`，验证账号中心的登录边界、
跨标签账号切换、站内通知、QQ 暂停状态、收藏夹和移动端交互。测试不会读写真实用户数据。

首次运行：

```bash
npm install
npx playwright install chromium
NOTIFICATIONS_ENABLED=1 QQ_NOTIFY_ENABLED=0 npm run build
PORT=19876 HOST=127.0.0.1 npm run start
```

另开终端执行：

```bash
npm run test:account
npm run test:auth-race
npm run test:expected-user
npm run test:expected-user:browser
```

默认矩阵是“站内通知开启、QQ 绑定与投递关闭”。`npm run test:account`
会验证铃铛、收件箱和通知设置可用，同时 QQ 模块对已绑定用户也完全隐藏。

QQ 恢复路径可使用同一份构建产物的运行时开关单独验证：

```bash
NUXT_PUBLIC_QQ_NOTIFY_ENABLED=true \
PORT=19876 HOST=127.0.0.1 npm run start

ACCOUNT_TEST_QQ_ENABLED=1 \
SCENARIO=notification-qq-capability-is-server-authoritative \
npm run test:account

ACCOUNT_TEST_QQ_ENABLED=1 \
SCENARIO=connections-feature-restorable \
npm run test:account
```

`ACCOUNT_TEST_QQ_ENABLED=1` 必须只配合已启用
`NUXT_PUBLIC_QQ_NOTIFY_ENABLED=true` 的运行时使用；默认关闭运行时会反向验证服务端
capability 不能绕过前端总开关。可用 `ACCOUNT_TEST_BASE_URL` 指向其他隔离端口，
或用 `SCENARIO` 只运行一个场景。

只有在专门验证站内通知紧急维护开关时，才使用
`NUXT_PUBLIC_NOTIFICATIONS_ENABLED=false` 启动服务，并配合
`ACCOUNT_TEST_NOTIFICATIONS_ENABLED=0 SCENARIO=legacy-and-paused-routes`。
