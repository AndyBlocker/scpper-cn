import { Client } from 'pg';

import { restrictedLegacySlug, type RestrictedV1Identity } from '../work/pendingPage.js';

const V1_DATABASES = new Set(['scpper-cn', 'scpper_cn']);

export function assertV1RestrictedReadOnlyUrl(connectionString: string): void {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!V1_DATABASES.has(database)) {
    throw new Error(`受限身份 fallback 的 v1 连接必须指向 scpper-cn，当前为 ${database || '<empty>'}`);
  }
  const options = url.searchParams
    .getAll('options')
    .map((value) => decodeURIComponent(value))
    .join(' ');
  if (!/(?:^|\s)-c\s*default_transaction_read_only=on(?:\s|$)/.test(options)) {
    throw new Error(
      'SYNCER2_V1_DATABASE_URL 必须保留服务端 default_transaction_read_only=on；拒绝连接 v1',
    );
  }
}

export function createRestrictedV1Client(connectionString: string): Client {
  assertV1RestrictedReadOnlyUrl(connectionString);
  return new Client({
    connectionString,
    application_name: 'syncer2-restricted-identity-v1-readonly',
    // URL 强制只读之外再加 startup packet 级保护；两道门缺一不可。
    options: '-c default_transaction_read_only=on -c statement_timeout=0',
  });
}

export async function assertRestrictedV1SessionReadOnly(client: Client): Promise<void> {
  const result = await client.query<{
    database: string;
    default_read_only: string;
    transaction_read_only: string;
  }>(
    `SELECT current_database() AS database,
            current_setting('default_transaction_read_only') AS default_read_only,
            current_setting('transaction_read_only') AS transaction_read_only`,
  );
  const row = result.rows[0];
  if (
    row === undefined
    || !V1_DATABASES.has(row.database)
    || row.default_read_only !== 'on'
    || row.transaction_read_only !== 'on'
  ) {
    throw new Error(
      `v1 只读会话校验失败：db=${row?.database ?? '<none>'}, `
      + `default=${row?.default_read_only ?? '<none>'}, tx=${row?.transaction_read_only ?? '<none>'}`,
    );
  }
  await client.query(`SET TIME ZONE 'UTC'`);
}

interface V1PageRow {
  id: number;
  wikidot_id: number | null;
  current_url: string | null;
  url: string;
}

function sourceUrlCandidates(legacySlug: string): string[] {
  return [
    `http://scp-wiki-cn.wikidot.com/${legacySlug}`,
    `https://scp-wiki-cn.wikidot.com/${legacySlug}`,
  ];
}

function slugFromSourceUrl(sourceUrl: string): string | null {
  try {
    return decodeURIComponent(new URL(sourceUrl).pathname.replace(/^\/+/, '')).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 一次只读批查询拿齐本轮受限 fullname。每个 legacy URL 必须恰有一条 live 且带
 * wikidotId 的 v1 身份；歧义/缺失不任选，由调用方进入 waiting_evidence。
 */
export async function loadRestrictedV1Identities(
  client: Client,
  slugs: readonly string[],
): Promise<Map<string, RestrictedV1Identity>> {
  const restricted = new Map<string, string>();
  for (const slug of slugs) {
    const legacy = restrictedLegacySlug(slug);
    if (legacy !== null) restricted.set(slug, legacy);
  }
  if (restricted.size === 0) return new Map();

  const urls = [...new Set([...restricted.values()].flatMap(sourceUrlCandidates))];
  const result = await client.query<V1PageRow>(
    `SELECT id, "wikidotId" AS wikidot_id,
            "currentUrl" AS current_url, url
       FROM "Page"
      WHERE NOT "isDeleted"
        AND COALESCE("currentUrl", url) = ANY($1::text[])
      ORDER BY id`,
    [urls],
  );
  const byLegacy = new Map<string, V1PageRow[]>();
  for (const row of result.rows) {
    const sourceUrl = row.current_url ?? row.url;
    const legacy = slugFromSourceUrl(sourceUrl);
    if (legacy === null) continue;
    const rows = byLegacy.get(legacy) ?? [];
    rows.push(row);
    byLegacy.set(legacy, rows);
  }

  const resolved = new Map<string, RestrictedV1Identity>();
  for (const [slug, legacy] of restricted) {
    const candidates = (byLegacy.get(legacy) ?? []).filter((row) => row.wikidot_id !== null);
    if (candidates.length !== 1) continue;
    const row = candidates[0]!;
    resolved.set(slug, {
      v1PageId: Number(row.id),
      wikidotId: Number(row.wikidot_id),
      legacySlug: legacy,
      sourceUrl: row.current_url ?? row.url,
    });
  }
  return resolved;
}
