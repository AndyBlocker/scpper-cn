import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { formatAuthQqBinding } from '../src/middleware/requireAuth.js';
import { qqBindingInternalRouter } from '../src/routes/qqBinding.js';
import {
  getQqBotSelfId,
  parseFeatureFlag,
  qqFeatureEnabled,
  qqNotificationsEnabled
} from '../src/utils/qqFeature.js';

test('feature flag 只接受明确真值，字符串 false 不会被误判为开启', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(parseFeatureFlag(value), true, value);
  }
  for (const value of ['', '0', 'false', 'no', 'off', 'unexpected', undefined]) {
    assert.equal(parseFeatureFlag(value), false, String(value));
  }
});

test('QQ capability 与路由共用：总开关和机器人账号必须同时就绪', () => {
  assert.equal(qqFeatureEnabled({
    QQ_NOTIFY_ENABLED: '1',
    QQ_BOT_SELF_ID: '1248393597'
  }), true);
  assert.equal(qqFeatureEnabled({
    QQ_NOTIFY_ENABLED: '1',
    QQ_BOT_SELF_ID: ' '
  }), false);
  assert.equal(qqFeatureEnabled({
    QQ_NOTIFY_ENABLED: '0',
    QQ_BOT_SELF_ID: '1248393597'
  }), false);
  assert.equal(getQqBotSelfId({ QQ_BOT_SELF_ID: ' 1248393597 ' }), '1248393597');
  assert.equal(qqNotificationsEnabled({
    QQ_NOTIFY_ENABLED: '1',
    QQ_BOT_SELF_ID: ' '
  }), true);
});

test('未绑定且功能开启时可以新建，但没有清理入口', () => {
  const summary = formatAuthQqBinding(null, false, {
    QQ_NOTIFY_ENABLED: '1',
    QQ_BOT_SELF_ID: '1248393597'
  });
  assert.deepEqual(summary.capabilities, {
    featureEnabled: true,
    createBinding: true,
    deliverNotifications: false,
    manageExistingBinding: false
  });
});

test('功能关闭时已有绑定仍可管理，但不会投递', () => {
  const summary = formatAuthQqBinding({
    address: '1248393597',
    status: 'ACTIVE'
  }, false, {
    QQ_NOTIFY_ENABLED: '0',
    QQ_BOT_SELF_ID: '1248393597'
  });
  assert.equal(summary.bound, true);
  assert.equal(summary.addressMask, '1248***7');
  assert.deepEqual(summary.capabilities, {
    featureEnabled: false,
    createBinding: false,
    deliverNotifications: false,
    manageExistingBinding: true
  });
});

test('功能关闭时 pending challenge 仍保留取消入口', () => {
  const summary = formatAuthQqBinding(null, true, {
    QQ_NOTIFY_ENABLED: '0',
    QQ_BOT_SELF_ID: '1248393597'
  });
  assert.equal(summary.pendingChallenge, true);
  assert.equal(summary.capabilities.manageExistingBinding, true);
  assert.equal(summary.capabilities.createBinding, false);
});

test('暂停绑定即使总开关开启也不会被标记为可投递', () => {
  const summary = formatAuthQqBinding({
    address: '1248393597',
    status: 'PAUSED'
  }, false, {
    QQ_NOTIFY_ENABLED: '1',
    QQ_BOT_SELF_ID: '1248393597'
  });
  assert.equal(summary.capabilities.featureEnabled, true);
  assert.equal(summary.capabilities.deliverNotifications, false);
});

test('机器人展示账号缺失时禁止新绑定，但既有 ACTIVE 绑定仍按总开关投递', () => {
  const environment = {
    QQ_NOTIFY_ENABLED: '1',
    QQ_BOT_SELF_ID: ' '
  };
  const unbound = formatAuthQqBinding(null, false, environment);
  assert.equal(unbound.capabilities.featureEnabled, true);
  assert.equal(unbound.capabilities.createBinding, false);
  assert.equal(unbound.capabilities.deliverNotifications, false);

  const bound = formatAuthQqBinding({
    address: '1248393597',
    status: 'ACTIVE'
  }, false, environment);
  assert.equal(bound.capabilities.featureEnabled, true);
  assert.equal(bound.capabilities.createBinding, false);
  assert.equal(bound.capabilities.deliverNotifications, true);
});

test('QQ 功能关闭时内部核销保持 200 + reply 协议且不会进入绑定写入', async () => {
  const previousInternalKey = process.env.QQ_BOT_INTERNAL_KEY;
  const previousNotifyFlag = process.env.QQ_NOTIFY_ENABLED;
  const previousBotId = process.env.QQ_BOT_SELF_ID;
  process.env.QQ_BOT_INTERNAL_KEY = 'qq-feature-test-key';
  process.env.QQ_NOTIFY_ENABLED = '0';
  process.env.QQ_BOT_SELF_ID = '1248393597';

  const app = express();
  app.use(express.json());
  app.use('/internal/qq-binding', qqBindingInternalRouter());
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/qq-binding/verify`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': 'qq-feature-test-key'
        },
        body: JSON.stringify({
          qq: '1248393597',
          code: 'SCPPER-ABCDEFGHJKM'
        })
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      ok: true,
      matched: false,
      reason: 'feature_disabled',
      reply: 'QQ 通知功能已暂时关闭，当前不接受新的绑定。'
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (previousInternalKey === undefined) delete process.env.QQ_BOT_INTERNAL_KEY;
    else process.env.QQ_BOT_INTERNAL_KEY = previousInternalKey;
    if (previousNotifyFlag === undefined) delete process.env.QQ_NOTIFY_ENABLED;
    else process.env.QQ_NOTIFY_ENABLED = previousNotifyFlag;
    if (previousBotId === undefined) delete process.env.QQ_BOT_SELF_ID;
    else process.env.QQ_BOT_SELF_ID = previousBotId;
  }
});
