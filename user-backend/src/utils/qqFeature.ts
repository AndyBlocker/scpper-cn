export type QqFeatureEnvironment = {
  [key: string]: string | undefined;
  QQ_NOTIFY_ENABLED?: string;
  QQ_BOT_SELF_ID?: string;
};

export function parseFeatureFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function getQqBotSelfId(
  environment: QqFeatureEnvironment = process.env
): string | null {
  return environment.QQ_BOT_SELF_ID?.trim() || null;
}

/** QQ 消息投递总开关；投递器使用同一判据，不依赖展示用机器人号码。 */
export function qqNotificationsEnabled(
  environment: QqFeatureEnvironment = process.env
): boolean {
  return parseFeatureFlag(environment.QQ_NOTIFY_ENABLED);
}

/**
 * 新建/核销 QQ 绑定还需要机器人账号，路由门禁与 `/auth/me` 的
 * createBinding capability 共用这里。已有 ACTIVE 绑定的投递能力只看上面的
 * 总开关，因为 backend 投递器并不依赖 QQ_BOT_SELF_ID。
 */
export function qqFeatureEnabled(
  environment: QqFeatureEnvironment = process.env
): boolean {
  return qqNotificationsEnabled(environment)
    && Boolean(getQqBotSelfId(environment));
}
