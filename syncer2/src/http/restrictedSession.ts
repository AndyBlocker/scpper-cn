/**
 * 受限分类身份发现的最小登录 session。
 *
 * 账号只用于 GET /<slug>/norender/true/noredirect/true 取得真实 pageId；投票、修订与
 * ListPages 全部仍走匿名请求。出口硬编码为本机 7890，禁止从通用 7891 配置继承。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as dotenv from 'dotenv';

import { PROJECT_ROOT } from '../config.js';
import {
  extractPageIdentity,
  slugToUrl,
  type IdentityOutcome,
} from '../page/identity.js';
import { createLogger, type Logger } from '../util/log.js';
import { HttpClient, HttpStatusError } from './client.js';

export const RESTRICTED_STABLE_PROXY_URL = 'http://127.0.0.1:7890';
export const RESTRICTED_TLS_MAX_VERSION = 'TLSv1.2' as const;
export const RESTRICTED_SESSION_RECHECK_MS = 20 * 60_000;

export interface WikidotCredentials {
  username: string;
  password: string;
  source: string;
}

export class RestrictedSessionUnavailableError extends Error {
  override readonly name = 'RestrictedSessionUnavailableError';
}

export interface RestrictedIdentityHttp {
  readonly proxyUrl: string | null;
  request: HttpClient['request'];
  get: HttpClient['get'];
}

export function loadRestrictedWikidotCredentials(
  env: NodeJS.ProcessEnv = process.env,
): WikidotCredentials | null {
  const directUser = env.WIKIDOT_USERNAME?.trim();
  const directPassword = env.WIKIDOT_PASSWORD?.trim();
  if (directUser && directPassword) {
    return { username: directUser, password: directPassword, source: 'environment' };
  }

  const configured = env.SYNCER2_WIKIDOT_CREDENTIALS_FILE?.trim();
  const candidates = [
    ...(configured ? [path.resolve(configured)] : []),
    path.resolve(PROJECT_ROOT, '../backend/.env'),
    '/home/andyblocker/scpper-cn/backend/.env',
  ];
  for (const file of [...new Set(candidates)]) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(file));
      const username = parsed['WIKIDOT_USERNAME']?.trim();
      const password = parsed['WIKIDOT_PASSWORD']?.trim();
      if (username && password) return { username, password, source: file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

export function createRestrictedStableHttp(options: {
  userAgent: string;
  referer: string;
  timeoutMs: number;
  maxAttempts: number;
  breaker503: number;
  breakerReset: number;
  connections?: number;
  logger?: Logger;
}): HttpClient {
  return new HttpClient({
    ...options,
    proxyUrl: RESTRICTED_STABLE_PROXY_URL,
    // 2026-08-06 实测：同一 7890/103.188.235.3 默认 TLS 协商被 Wikidot reset，
    // TLS 1.2 连续返回 200。只限制这一个专用客户端，不改全站通用出口。
    tlsMaxVersion: RESTRICTED_TLS_MAX_VERSION,
    connections: options.connections ?? 2,
  });
}

export class RestrictedIdentitySession {
  #sessionId: string | null = null;
  #loggedInAt = 0;

  constructor(
    readonly http: RestrictedIdentityHttp,
    readonly credentials: WikidotCredentials,
    readonly baseUrl: string,
    readonly logger: Logger = createLogger('restricted-session'),
  ) {
    if (http.proxyUrl !== RESTRICTED_STABLE_PROXY_URL) {
      throw new RestrictedSessionUnavailableError(
        `受限身份 session 只允许 ${RESTRICTED_STABLE_PROXY_URL}，收到 ${String(http.proxyUrl)}`,
      );
    }
  }

  async fetchIdentity(slug: string): Promise<IdentityOutcome> {
    if (!isRestrictedSlug(slug)) {
      throw new RangeError(`受限 session 拒绝普通 slug：${slug}`);
    }
    await this.#ensureSession(false);
    let outcome = await this.#fetchAuthenticated(slug);
    if (isExpiredSessionOutcome(outcome, slug)) {
      this.logger.warn('登录态失效或未获受限页身份，强制重登并重试一次', {
        slug,
        disposition: outcome.kind,
      });
      await this.#ensureSession(true);
      outcome = await this.#fetchAuthenticated(slug);
      if (isExpiredSessionOutcome(outcome, slug)) {
        this.#sessionId = null;
        throw new RestrictedSessionUnavailableError(
          `重登后仍未取得 ${slug} 的真实身份（${describeOutcome(outcome)}）`,
        );
      }
    }
    return outcome;
  }

  async logout(): Promise<void> {
    const sessionId = this.#sessionId;
    this.#sessionId = null;
    this.#loggedInAt = 0;
    if (sessionId === null) return;
    const token = randomBytes(8).toString('hex');
    try {
      await this.http.request(`${this.baseUrl.replace(/\/+$/, '')}/ajax-module-connector.php`, {
        mode: 'restricted:logout',
        method: 'POST',
        headers: {
          referer: `${this.baseUrl.replace(/\/+$/, '')}/`,
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          cookie: `WIKIDOT_SESSION_ID=${sessionId}; wikidot_token7=${token}`,
        },
        body: new URLSearchParams({
          moduleName: 'Empty',
          action: 'Login2Action',
          event: 'logout',
          wikidot_token7: token,
        }).toString(),
        maxAttempts: 1,
      });
    } catch (err) {
      this.logger.warn('受限 session 登出失败（session 已从本进程清除）', { error: String(err) });
    }
  }

  async #ensureSession(force: boolean): Promise<void> {
    if (
      !force &&
      this.#sessionId !== null &&
      Date.now() - this.#loggedInAt < RESTRICTED_SESSION_RECHECK_MS
    ) {
      return;
    }
    this.#sessionId = null;
    const token = randomBytes(8).toString('hex');
    let response;
    try {
      response = await this.http.request(
        'https://www.wikidot.com/default--flow/login__LoginPopupScreen',
        {
          mode: force ? 'restricted:relogin' : 'restricted:login',
          method: 'POST',
          headers: {
            referer: 'https://www.wikidot.com/',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            cookie: `wikidot_token7=${token}`,
          },
          body: new URLSearchParams({
            login: this.credentials.username,
            password: this.credentials.password,
            action: 'Login2Action',
            event: 'login',
          }).toString(),
          maxAttempts: 2,
        },
      );
    } catch (err) {
      throw new RestrictedSessionUnavailableError(`Wikidot 登录请求失败：${String(err)}`);
    }
    const body = response.text();
    if (body.includes('The login and password do not match')) {
      throw new RestrictedSessionUnavailableError('Wikidot 登录凭证被拒绝');
    }
    const setCookie = response.headers['set-cookie'] ?? '';
    const sessionId = /(?:^|[,;]\s*)WIKIDOT_SESSION_ID=([^;,]+)/.exec(setCookie)?.[1];
    if (!sessionId) {
      throw new RestrictedSessionUnavailableError('Wikidot 登录响应缺少 WIKIDOT_SESSION_ID');
    }
    this.#sessionId = sessionId;
    this.#loggedInAt = Date.now();
    this.logger.info(force ? '受限身份 session 已重新建立' : '受限身份 session 已建立', {
      proxyUrl: this.http.proxyUrl,
      credentialSource: this.credentials.source,
    });
  }

  async #fetchAuthenticated(slug: string): Promise<IdentityOutcome> {
    const sessionId = this.#sessionId;
    if (sessionId === null) {
      throw new RestrictedSessionUnavailableError('内部错误：未登录就请求受限身份');
    }
    const url = `${slugToUrl(this.baseUrl, slug)}/norender/true/noredirect/true`;
    try {
      const response = await this.http.get(url, 'restricted:identity', {
        headers: { cookie: `WIKIDOT_SESSION_ID=${sessionId}` },
        maxAttempts: 2,
      });
      const identity = extractPageIdentity(response.text());
      if (identity === null) {
        return {
          kind: 'failed',
          httpStatus: response.status,
          error: `登录态 HTTP ${response.status} 但解析不出 pageId`,
        };
      }
      const observed = (identity.pageUnixName ?? identity.requestPageName ?? '').toLowerCase();
      if (observed !== slug.toLowerCase()) {
        return { kind: 'mismatch', httpStatus: response.status, identity, observedSlug: observed };
      }
      return {
        kind: 'ok',
        httpStatus: response.status,
        identity,
        wireBytes: response.telemetry.wireBytes,
        durationMs: response.telemetry.durationMs,
      };
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) {
        return { kind: 'gone', httpStatus: 404, error: '登录态受限页 GET 返回 404' };
      }
      if (err instanceof HttpStatusError) {
        return { kind: 'failed', httpStatus: err.status, error: String(err) };
      }
      throw err;
    }
  }
}

export function isRestrictedSlug(slug: string): boolean {
  const value = slug.toLowerCase();
  return value.startsWith('adult:') || value.startsWith('wanderers-adult:');
}

function isExpiredSessionOutcome(outcome: IdentityOutcome, slug: string): boolean {
  if (outcome.kind === 'mismatch') return true;
  if (outcome.kind !== 'ok') {
    // Wikidot 的失效态随入口/边缘节点可能表现为登录页 200、redirect 302，或 401/403；
    // 404 已在上层归为 gone，不能用重登把真实删除伪装成 session 故障。
    return outcome.kind === 'failed'
      && outcome.httpStatus !== null
      && [200, 302, 401, 403].includes(outcome.httpStatus);
  }
  const observed = (outcome.identity.pageUnixName ?? outcome.identity.requestPageName ?? '').toLowerCase();
  return observed !== slug.toLowerCase();
}

function describeOutcome(outcome: IdentityOutcome): string {
  if (outcome.kind === 'mismatch') {
    return `mismatch:${outcome.observedSlug}:${outcome.identity.wikidotId}`;
  }
  if (outcome.kind === 'ok') return `ok:${outcome.identity.wikidotId}`;
  return `${outcome.kind}:${outcome.error}`;
}
