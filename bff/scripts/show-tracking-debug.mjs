#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

function getConnectionString() {
  const url = process.env.DATABASE_URL || process.env.PG_DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL or PG_DATABASE_URL must be set');
  }
  return url;
}

async function main() {
  const limitRaw = process.argv[2];
  const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 10;
  const showHeaders = String(process.env.SHOW_DEBUG_HEADERS || '').toLowerCase() === 'true';

  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    const { rows: existsRows } = await client.query(
      "SELECT to_regclass('tracking_debug_event') AS table_name"
    );
    if (!existsRows[0]?.table_name) {
      console.log('tracking_debug_event table not found. Make sure ENABLE_TRACKING_DEBUG is on and a debug pixel was hit.');
      return;
    }

    const { rows } = await client.query(
      `SELECT id,
              kind,
              wikidot_id,
              username,
              page_id,
              user_id,
              client_ip_raw,
              client_ip_resolved,
              remote_address,
              forwarded_for,
              user_agent_trimmed,
              referer_host,
              component,
              source,
              deduped,
              headers,
              query,
              created_at
         FROM tracking_debug_event
        ORDER BY id DESC
        LIMIT $1`,
      [limit]
    );

    console.table(
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        wikidotId: row.wikidot_id ?? '',
        username: row.username ?? '',
        pageId: row.page_id ?? '',
        userId: row.user_id ?? '',
        clientIpRaw: row.client_ip_raw ?? '',
        clientIpResolved: row.client_ip_resolved ?? '',
        forwardedFor: row.forwarded_for ?? '',
        ua: row.user_agent_trimmed ?? '',
        refererHost: row.referer_host ?? '',
        component: row.component ?? '',
        source: row.source ?? '',
        deduped: row.deduped,
        at: row.created_at
      }))
    );

    if (showHeaders) {
      rows.forEach((row) => {
        const at = row.created_at?.toISOString?.() || row.created_at;
        console.log(`\n#${row.id} ${row.kind} (${at})`);
        console.log('Headers:', JSON.stringify(row.headers || {}, null, 2));
        console.log('Query:', JSON.stringify(row.query || {}, null, 2));
      });
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
