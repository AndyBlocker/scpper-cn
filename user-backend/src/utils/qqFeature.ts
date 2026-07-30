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

/**
 * QQ 绑定和投递只有在总开关与机器人账号同时就绪时才算可用。
 * 路由门禁与 `/auth/me` capability 必须共用这里，避免界面和接口各自判断。
 */
export function qqFeatureEnabled(
  environment: QqFeatureEnvironment = process.env
): boolean {
  return parseFeatureFlag(environment.QQ_NOTIFY_ENABLED)
    && Boolean(getQqBotSelfId(environment));
}
