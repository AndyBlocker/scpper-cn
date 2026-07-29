/**
 * 调用 qqbot 的推送接口。
 *
 * 结构对照 user-backend/src/services/mail.ts（同仓「调用外部 agent」的既有范式）：
 * 单一出口函数、鉴权头集中处理、非 2xx 必须视为失败。
 * 额外加了硬超时 —— mail.ts 没有超时，一次挂起的 fetch 会拖住整轮投递。
 */

const QQ_BOT_BASE_URL = (process.env.QQ_BOT_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const QQ_BOT_API_TOKEN = (process.env.QQ_BOT_API_TOKEN || '').trim();
const TIMEOUT_MS = Math.max(1000, Number(process.env.QQ_BOT_TIMEOUT_MS ?? '5000') || 5000);

/** 与 qqbot external_api.py 的 CONTRACT_VERSION 对齐；不一致时只告警不阻断。 */
export const EXPECTED_CONTRACT = '1.0.0';

export type PushErrorCode =
  | 'not_friend'
  | 'rate_limited'
  | 'send_failed'
  | 'friend_list_unavailable'
  | 'bot_offline'
  | 'not_configured'
  | 'timeout'
  | 'transport_error'
  | 'bad_response'
  /** 机器人回了一个本端不认识的错误码 —— 见 normalizePushError */
  | 'unknown_error';

/**
 * 机器人 /scpper/qq/push 契约里**实际会返回**的错误码
 * （qqbot external_api.py 的 _push_one，2026-07 核对）。
 * 其余的由本端自己产生（超时、传输错误等）。
 */
const BOT_ERROR_CODES = new Set<string>([
  'not_friend',
  'rate_limited',
  'friend_list_unavailable',
  'send_failed'
]);

/**
 * 把机器人回的 error 字段收敛成已知枚举。
 *
 * 原先是 `data.error as PushErrorCode` —— 一个无校验的强制转换：
 * 机器人若新增一个错误码（升级、换实现），这里会原样放行，
 * isPermanentFailure 认不出就一律判为「可重试」，于是
 * 投递器每轮撤销占位、重发、再失败，永远循环，而绑定始终是 ACTIVE、
 * 渠道健康计数一次都不涨 —— 用户界面上看一切正常，实际一条都收不到。
 *
 * 现在未知码统一收敛成 unknown_error 并显式告警：
 * 仍按可重试处理（未知的东西更可能是暂时性的，直接判永久会误杀），
 * 但它会出现在日志与 notify-inspect 的失败分布里，而不是无声打转。
 */
export function normalizePushError(raw: unknown): PushErrorCode {
  if (typeof raw !== 'string' || raw.length === 0) return 'send_failed';
  if (BOT_ERROR_CODES.has(raw)) return raw as PushErrorCode;
  console.warn(
    `[notify] qqbot 返回了未知错误码「${raw}」—— 本端按可重试处理。`
    + ' 若它其实是永久性失败，请把它加入 BOT_ERROR_CODES 与 isPermanentFailure。'
  );
  return 'unknown_error';
}

export interface PushResult {
  ok: boolean;
  error?: PushErrorCode;
  deduped?: boolean;
}

/**
 * 哪些失败是永久性的、不该重试。
 *
 * not_friend 是关键一条：用户没加好友（或把机器人删了），重试一万次也不会成功，
 * 只会白白消耗投递配额并在日志里刷屏。这类直接置 FAILED 并触发渠道健康计数。
 */
export function isPermanentFailure(code: PushErrorCode | undefined): boolean {
  return code === 'not_friend' || code === 'not_configured';
}

async function call<T>(pathname: string, init: RequestInit): Promise<{ status: number; data: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${QQ_BOT_BASE_URL}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(QQ_BOT_API_TOKEN ? { Authorization: `Bearer ${QQ_BOT_API_TOKEN}` } : {}),
        ...(init.headers as Record<string, string> | undefined)
      }
    });
    const data = (await response.json().catch(() => null)) as T | null;
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthInfo {
  ok: boolean;
  contract?: string;
  onlineSelfIds: number[];
}

export async function checkHealth(): Promise<HealthInfo> {
  if (!QQ_BOT_API_TOKEN) return { ok: false, onlineSelfIds: [] };
  try {
    const { status, data } = await call<{ ok: boolean; contract: string; online_self_ids: number[] }>(
      '/scpper/qq/health',
      { method: 'GET' }
    );
    if (status !== 200 || !data?.ok) return { ok: false, onlineSelfIds: [] };
    return { ok: true, contract: data.contract, onlineSelfIds: data.online_self_ids ?? [] };
  } catch {
    return { ok: false, onlineSelfIds: [] };
  }
}

/**
 * 推送一条私聊。
 *
 * dedupeKey 透传给机器人做二次幂等：本进程崩溃重启后可能重发同一条投递，
 * 机器人侧的 15 分钟去重表能挡住绝大多数「用户收到两条一样的消息」。
 */
export async function pushQqMessage(params: {
  qq: string;
  message: string;
  dedupeKey?: string;
}): Promise<PushResult> {
  if (!QQ_BOT_API_TOKEN) {
    return { ok: false, error: 'not_configured' };
  }
  try {
    const { status, data } = await call<{ ok: boolean; error?: string; deduped?: boolean }>(
      '/scpper/qq/push',
      {
        method: 'POST',
        body: JSON.stringify({
          qq: Number(params.qq),
          message: params.message,
          dedup_key: params.dedupeKey
        })
      }
    );

    if (status === 503) return { ok: false, error: 'bot_offline' };
    if (status !== 200) return { ok: false, error: 'bad_response' };
    if (!data) return { ok: false, error: 'bad_response' };
    if (data.ok) return { ok: true, deduped: Boolean(data.deduped) };
    return { ok: false, error: normalizePushError(data.error) };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { ok: false, error: name === 'AbortError' ? 'timeout' : 'transport_error' };
  }
}
