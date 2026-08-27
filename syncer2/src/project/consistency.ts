import type { PoolClient } from 'pg';
import { rows } from './sql.js';

const DELETED_AUTHOR_RATING_SAMPLE_SIZE = 64;

interface RatingConsistencyRow {
  checked: string;
  mismatched: string;
  examples: Array<{
    user_id: number;
    cum_rating: number;
    total_rating: number;
  }> | null;
}

/**
 * B2/B4 自洽性断言。
 *
 * B2 的 user_stats.total_rating 只含现存作品；B4 又在删除日把已删页完整评分扣回，
 * 因而有已删作品作者的曲线末值必须与主页总评分完全相等。这里用稳定哈希做随机样本，
 * 既避免每轮全量传回应用层，也让失败样本可复现。
 */
export async function assertDeletedAuthorRatingConsistency(
  client: PoolClient,
  sampleSize = DELETED_AUTHOR_RATING_SAMPLE_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 1_000) {
    throw new RangeError(`B2/B4 抽样数必须在 1..1000，收到 ${sampleSize}`);
  }

  const result = await rows<RatingConsistencyRow>(
    client,
    'project.user_stats:assert_b2_b4_consistency',
    `WITH deleted_authors AS (
       SELECT DISTINCT ac.actor_id AS user_id
         FROM serve.page_current pc
         JOIN serve.attribution_current ac
           ON ac.page_id = pc.page_id AND ac.is_display
        WHERE pc.status = 'deleted'
          AND EXISTS (
            SELECT 1
              FROM ingest.page_life_event ple
             WHERE ple.page_id = pc.page_id
               AND ple.kind = 'deleted'
          )
     ),
     latest_curve AS (
       SELECT DISTINCT ON (uad.user_id)
              uad.user_id, uad.cum_rating
         FROM serve.user_attr_daily uad
         JOIN deleted_authors da ON da.user_id = uad.user_id
        ORDER BY uad.user_id, uad.day DESC
     ),
     sample AS (
       SELECT da.user_id,
              lc.cum_rating,
              us.total_rating
         FROM deleted_authors da
         JOIN latest_curve lc ON lc.user_id = da.user_id
         JOIN serve.user_stats us ON us.user_id = da.user_id
        ORDER BY hashtextextended(da.user_id::text, 20260728), da.user_id
        LIMIT $1::int
     )
     SELECT count(*)::text AS checked,
            count(*) FILTER (WHERE cum_rating <> total_rating)::text AS mismatched,
            json_agg(
              json_build_object(
                'user_id', user_id,
                'cum_rating', cum_rating,
                'total_rating', total_rating
              )
              ORDER BY user_id
            ) FILTER (WHERE cum_rating <> total_rating) AS examples
       FROM sample`,
    [sampleSize],
  );
  const summary = result[0];
  const checked = Number(summary?.checked ?? 0);
  const mismatched = Number(summary?.mismatched ?? 0);
  if (mismatched > 0) {
    throw new Error(
      `B2/B4 自洽性失败：稳定随机抽样 ${checked} 位有已删作品作者，` +
        `${mismatched} 位曲线末值不等于 user_stats.total_rating；` +
        `样例=${JSON.stringify(summary?.examples?.slice(0, 10) ?? [])}`,
    );
  }
  return checked;
}

/**
 * 对本轮窗口里新出现、且当前仍处于 deleted 的作品作者再做一次定向断言。
 *
 * 全局稳定样本保证每轮都有固定的历史哨兵；窗口样本则保证刚发生的删除不会因为
 * 全局作者数超过 sampleSize 而暂时抽不到。两者必须同时通过。
 */
export async function assertWindowDeletedAuthorRatingConsistency(
  client: PoolClient,
  fromSeq: number,
  toSeq: number,
  sampleSize = DELETED_AUTHOR_RATING_SAMPLE_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 1_000) {
    throw new RangeError(`B2/B4 抽样数必须在 1..1000，收到 ${sampleSize}`);
  }
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 0) {
    throw new RangeError(`B2/B4 窗口非法：${fromSeq}..${toSeq}`);
  }
  // 空窗口（本轮零新事件，fromSeq = previousSeq+1 > watermark）是合法状态而非错误：
  // 站点安静时 projector 每轮都会走到这里。此前抛 RangeError 会让整轮投影失败，
  // 表现为「一没有新投票，投影就崩」。零事件无需抽样校验，直接返回 0 位受检作者。
  if (toSeq < fromSeq) {
    return 0;
  }

  const result = await rows<RatingConsistencyRow>(
    client,
    'project.user_stats:assert_b2_b4_window_consistency',
    `WITH deleted_authors AS (
       SELECT DISTINCT ac.actor_id AS user_id
         FROM ingest.page_life_event ple
         JOIN serve.page_current pc
           ON pc.page_id = ple.page_id AND pc.status = 'deleted'
         JOIN serve.attribution_current ac
           ON ac.page_id = pc.page_id AND ac.is_display
        WHERE ple.kind = 'deleted'
          AND ple.seq BETWEEN $1::bigint AND $2::bigint
     ),
     latest_curve AS (
       SELECT DISTINCT ON (uad.user_id)
              uad.user_id, uad.cum_rating
         FROM serve.user_attr_daily uad
         JOIN deleted_authors da ON da.user_id = uad.user_id
        ORDER BY uad.user_id, uad.day DESC
     ),
     sample AS (
       SELECT da.user_id,
              lc.cum_rating,
              us.total_rating
         FROM deleted_authors da
         JOIN latest_curve lc ON lc.user_id = da.user_id
         JOIN serve.user_stats us ON us.user_id = da.user_id
        ORDER BY hashtextextended(da.user_id::text, 20260728), da.user_id
        LIMIT $3::int
     )
     SELECT count(*)::text AS checked,
            count(*) FILTER (WHERE cum_rating <> total_rating)::text AS mismatched,
            json_agg(
              json_build_object(
                'user_id', user_id,
                'cum_rating', cum_rating,
                'total_rating', total_rating
              )
              ORDER BY user_id
            ) FILTER (WHERE cum_rating <> total_rating) AS examples
       FROM sample`,
    [fromSeq, toSeq, sampleSize],
  );
  const summary = result[0];
  const checked = Number(summary?.checked ?? 0);
  const mismatched = Number(summary?.mismatched ?? 0);
  if (mismatched > 0) {
    throw new Error(
      `B2/B4 本轮删除自洽性失败：窗口 ${fromSeq}..${toSeq} 抽样 ${checked} 位作者，`
        + `${mismatched} 位曲线末值不等于 user_stats.total_rating；`
        + `样例=${JSON.stringify(summary?.examples?.slice(0, 10) ?? [])}`,
    );
  }
  return checked;
}
