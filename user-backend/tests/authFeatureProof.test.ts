import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAuthQqBinding } from '../src/middleware/requireAuth.js';
import {
  getQqBotSelfId,
  parseFeatureFlag,
  qqFeatureEnabled
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
});

test('未绑定且功能开启时可以新建，但没有清理入口', () => {
  const summary = formatAuthQqBinding(null, false, true);
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
  }, false, false);
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
  const summary = formatAuthQqBinding(null, true, false);
  assert.equal(summary.pendingChallenge, true);
  assert.equal(summary.capabilities.manageExistingBinding, true);
  assert.equal(summary.capabilities.createBinding, false);
});

test('暂停绑定即使总开关开启也不会被标记为可投递', () => {
  const summary = formatAuthQqBinding({
    address: '1248393597',
    status: 'PAUSED'
  }, false, true);
  assert.equal(summary.capabilities.featureEnabled, true);
  assert.equal(summary.capabilities.deliverNotifications, false);
});
