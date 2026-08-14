import type { Pool } from 'pg';

import type { L1ListPageRow } from '../collect/incrementalListPages.js';
import { chunk } from '../util/concurrency.js';
import { query, toPgTimestamptz } from './db.js';
import { toPgJson } from './pgText.js';

export interface L1VoteObservationState {
  slug: string;
  pageId: number | null;
  rating: number;
  ratingVotes: number;
  observedAt: string;
  runId: number | null;
  observationScope: 'partial' | 'full';
}

interface StoredRow {
  slug: string;
  page_id: number | null;
  rating: number;
  rating_votes: number;
  observed_at: Date | string;
  run_id: string | number | null;
  observation_scope: 'partial' | 'full';
}

export async function loadL1VoteObservationStates(
  pool: Pool,
  slugs: readonly string[],
): Promise<Map<string, L1VoteObservationState>> {
  const states = new Map<string, L1VoteObservationState>();
  for (const part of chunk([...new Set(slugs)], 5_000)) {
    if (part.length === 0) continue;
    const result = await query<StoredRow>(
      pool,
      'l1-partial-votes:load-state',
      `SELECT slug, page_id, rating, rating_votes, observed_at,
              run_id, observation_scope
         FROM meta.l1_partial_vote_state
        WHERE slug = ANY($1::text[])`,
      [part],
    );
    for (const row of result.rows) {
      states.set(row.slug, {
        slug: row.slug,
        pageId: row.page_id === null ? null : Number(row.page_id),
        rating: Number(row.rating),
        ratingVotes: Number(row.rating_votes),
        observedAt: new Date(row.observed_at).toISOString(),
        runId: row.run_id === null ? null : Number(row.run_id),
        observationScope: row.observation_scope,
      });
    }
  }
  return states;
}

/**
 * 只推进“这个 slug 的 rating/rating_votes 被明确看到”这一条水位。该表不含 revision、
 * full-site seen 或缺席计数，调用方从结构上无法拿它授权删除/修订覆盖/漂移连续性。
 */
export async function upsertL1VoteObservationStates(
  pool: Pool,
  runId: number,
  rows: ReadonlyArray<{ row: L1ListPageRow; pageId?: number | null }>,
  observedAt: string,
  observationScope: 'partial' | 'full',
): Promise<number> {
  let affected = 0;
  // Keep the full-coverage reconciliation cheap: PostgreSQL handles this shape
  // comfortably, while eight statements avoid adding seconds to every L1 run.
  for (const part of chunk(rows, 5_000)) {
    if (part.length === 0) continue;
    const payload = part.map(({ row, pageId }) => ({
      slug: row.fullname,
      page_id: pageId ?? null,
      rating: row.rating,
      rating_votes: row.ratingVotes,
    }));
    const result = await query(
      pool,
      'l1-partial-votes:upsert-state',
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           slug text, page_id int, rating int, rating_votes int
         )
       )
       INSERT INTO meta.l1_partial_vote_state AS state(
         slug, page_id, rating, rating_votes, observed_at, run_id, observation_scope
       )
       SELECT slug, page_id, rating, rating_votes, $2::timestamptz, $3::bigint, $4
         FROM input
       ON CONFLICT (slug) DO UPDATE
         SET page_id = COALESCE(EXCLUDED.page_id, state.page_id),
             rating = EXCLUDED.rating,
             rating_votes = EXCLUDED.rating_votes,
             observed_at = EXCLUDED.observed_at,
             run_id = EXCLUDED.run_id,
             observation_scope = EXCLUDED.observation_scope,
             updated_at = now()
         WHERE EXCLUDED.observed_at >= state.observed_at`,
      [
        toPgJson(payload, 'l1_partial_vote_state'),
        toPgTimestamptz(observedAt),
        runId,
        observationScope,
      ],
    );
    affected += result.rowCount ?? 0;
  }
  return affected;
}
