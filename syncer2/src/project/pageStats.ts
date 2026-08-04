import type { PoolClient } from 'pg';
import { exec, rows } from './sql.js';
import type { ProjectionApplyResult, ProjectionWindow } from './types.js';

interface CountRow {
  n: string;
}

export async function projectPageStats(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  if (window.rebuild) {
    await exec(client, 'project.page_stats:truncate', `TRUNCATE TABLE serve.page_stats`);
  }

  const affected = await rows<CountRow>(
    client,
    'project.page_stats:affected',
    `WITH affected AS (
       SELECT DISTINCT page_id
         FROM (
           SELECT page_id FROM ingest.vote_event
            WHERE seq BETWEEN $1::bigint AND $2::bigint
           UNION ALL
           SELECT page_id FROM ingest.vote_snapshot_event
            WHERE seq BETWEEN $1::bigint AND $2::bigint
         ) changed
     )
     SELECT count(*)::text AS n FROM affected`,
    [window.fromSeq, window.toSeq],
  );
  const affectedKeys = Number(affected[0]?.n ?? 0);
  if (affectedKeys === 0) return { affectedKeys: 0, rowsWritten: 0 };

  const rowsWritten = await exec(
    client,
    'project.page_stats:upsert',
    `WITH affected AS (
       SELECT DISTINCT page_id
         FROM (
           SELECT page_id FROM ingest.vote_event
            WHERE seq BETWEEN $1::bigint AND $2::bigint
           UNION ALL
           SELECT page_id FROM ingest.vote_snapshot_event
            WHERE seq BETWEEN $1::bigint AND $2::bigint
         ) changed
     ),
     agg AS (
       SELECT a.page_id,
              count(*) FILTER (WHERE vc.direction > 0)::int AS uv,
              count(*) FILTER (WHERE vc.direction < 0)::int AS dv
         FROM affected a
         LEFT JOIN serve.vote_current vc
           ON vc.page_id = a.page_id
          AND vc.direction <> 0
        GROUP BY a.page_id
     ),
     scored AS (
       SELECT page_id, uv, dv,
              CASE WHEN uv + dv = 0 THEN 0::double precision
                   ELSE (
                     uv::double precision / (uv + dv)
                     + power(1.96, 2) / (2 * (uv + dv))
                     - 1.96 * sqrt(
                         (
                           (uv::double precision / (uv + dv))
                           * (1 - uv::double precision / (uv + dv))
                           + power(1.96, 2) / (4 * power(uv + dv, 2))
                         ) / (uv + dv)
                       )
                   ) / (1 + power(1.96, 2) / (uv + dv))
              END::real AS wilson95,
              CASE WHEN uv + dv = 0 THEN 0::double precision
                   ELSE (4.0 * uv::double precision * dv::double precision)
                        / power(uv + dv, 2)
              END::real AS controversy,
              CASE WHEN uv + dv = 0 THEN 0::double precision
                   ELSE uv::double precision / (uv + dv)
              END::real AS like_ratio
         FROM agg
     )
     INSERT INTO serve.page_stats
       (page_id, uv, dv, wilson95, controversy, like_ratio, computed_at)
     SELECT page_id, uv, dv, wilson95, controversy, like_ratio, now()
       FROM scored
     ON CONFLICT (page_id) DO UPDATE SET
       uv = EXCLUDED.uv,
       dv = EXCLUDED.dv,
       wilson95 = EXCLUDED.wilson95,
       controversy = EXCLUDED.controversy,
       like_ratio = EXCLUDED.like_ratio,
       computed_at = EXCLUDED.computed_at`,
    [window.fromSeq, window.toSeq],
  );
  return { affectedKeys, rowsWritten };
}
