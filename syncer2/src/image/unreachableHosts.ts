import type { Pool } from 'pg';

import { query } from '../store/db.js';

/**
 * 站外图床「推定不可达」的收敛路径。
 *
 * 背景：host_deferred 按设计永不终态化——对临时限速这是对的，闸退让不该消耗失败预算。
 * 但对**永远不会恢复**的主机，这条豁免让任务无限空转：实测
 * www.scp-wiki.net / ja.scp-wiki.net（旧域名，解析到 107.20.139.176 但连不上）与
 * acsurlexample.com（页面源码里的示例 URL，DNS 无解析）三者共 603 个任务，
 * 自 07-29 入队起反复认领、反复推迟，六小时内产生 7,000+ 条跳过日志、零产出。
 *
 * 为什么不能靠 isHostUnresolvable() 的 DNS 判据：**走代理时 DNS 由远端解析**，
 * 本地只看到 "transport reset"，ENOTFOUND 永远不会出现。该判据在直连下有效，
 * 在生产的代理链路下不可观测。
 *
 * 因此改用代理下同样可观测的信号：**该主机历史上从未成功过一次**。
 * 实测对比极其干净——三个死主机 0/324、0/261、0/206；
 * 而健康主机 scp-wiki.wdfiles.com 21,093 次成功、scpsandboxcn 19,167 次。
 * 只要一个主机成功过一次，就永远不会被这条判据命中。
 */
export const UNREACHABLE_HOST_MIN_ATTEMPTED_JOBS = 20;
export const UNREACHABLE_HOST_MIN_OBSERVATION_HOURS = 48;

export interface UnreachableHostRow {
  host: string;
  terminalized: number;
  attemptedJobs: number;
  observedHours: number;
}

export interface UnreachableHostSweepResult {
  hosts: UnreachableHostRow[];
  terminalized: number;
}

/**
 * 把「推定不可达」主机的 pending 任务收口为 host_unresolvable（确定性失败）。
 *
 * 三条护栏同时成立才动手，任一不满足即放过：
 *  1. 该主机**从未**有过 completed —— 只要成功过一次就永久豁免；
 *  2. 已尝试过的任务数 ≥ 阈值 —— 排除样本太小的新主机；
 *  3. 最早入队距今 ≥ 观察窗 —— 排除主机临时故障。
 *
 * 站点主机（wikidot 本身）永不参与：主站连不上通常是瞬时的，语义与站外图床不同。
 */
export async function sweepUnreachableExternalHosts(
  pool: Pool,
  siteHost: string,
  options: {
    minAttemptedJobs?: number;
    minObservationHours?: number;
  } = {},
): Promise<UnreachableHostSweepResult> {
  const minAttempted = options.minAttemptedJobs ?? UNREACHABLE_HOST_MIN_ATTEMPTED_JOBS;
  const minHours = options.minObservationHours ?? UNREACHABLE_HOST_MIN_OBSERVATION_HOURS;
  if (!Number.isSafeInteger(minAttempted) || minAttempted <= 0) {
    throw new RangeError(`minAttemptedJobs 必须是正整数，收到 ${minAttempted}`);
  }
  if (!Number.isFinite(minHours) || minHours <= 0) {
    throw new RangeError(`minObservationHours 必须为正，收到 ${minHours}`);
  }
  const result = await query<{
    host: string;
    terminalized: string;
    attempted_jobs: string;
    observed_hours: string;
  }>(
    pool,
    'image:sweep_unreachable_hosts',
    `WITH host_stats AS (
       SELECT substring(normalized_url FROM 'https?://([^/]+)') AS host,
              count(*) FILTER (WHERE status = 'completed') AS completed,
              count(*) FILTER (WHERE attempts >= 1) AS attempted,
              count(*) FILTER (WHERE status = 'pending') AS pending,
              min(created_at) AS first_seen
         FROM meta.image_ingest_job
        GROUP BY 1
     ),
     dead AS (
       SELECT host, attempted,
              extract(epoch FROM now() - first_seen) / 3600 AS observed_hours
         FROM host_stats
        WHERE host IS NOT NULL
          AND host <> lower($1)
          AND completed = 0
          AND attempted >= $2
          AND pending > 0
          AND first_seen <= now() - ($3 || ' hours')::interval
     ),
     updated AS (
       UPDATE meta.image_ingest_job j
          SET status = 'failed',
              failure_class = 'host_unresolvable',
              error = '主机推定不可达：历史 0 次成功，已观察 '
                      || round(dead.observed_hours)::text || ' 小时 / '
                      || dead.attempted::text || ' 个已尝试任务',
              not_before = NULL,
              locked_by = NULL,
              locked_at = NULL,
              updated_at = now()
         FROM dead
        WHERE j.status = 'pending'
          AND substring(j.normalized_url FROM 'https?://([^/]+)') = dead.host
       RETURNING dead.host, dead.attempted, dead.observed_hours
     )
     SELECT host,
            count(*)::text AS terminalized,
            max(attempted)::text AS attempted_jobs,
            round(max(observed_hours))::text AS observed_hours
       FROM updated
      GROUP BY host
      ORDER BY count(*) DESC`,
    [siteHost, minAttempted, minHours],
  );
  const hosts = result.rows.map((row) => ({
    host: row.host,
    terminalized: Number(row.terminalized),
    attemptedJobs: Number(row.attempted_jobs),
    observedHours: Number(row.observed_hours),
  }));
  return { hosts, terminalized: hosts.reduce((sum, row) => sum + row.terminalized, 0) };
}
