#!/usr/bin/env python3
import io
import os
import subprocess
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import numpy as np
import pandas as pd

PSQL_BIN = '/usr/lib/postgresql/17/bin/psql'
DB_URL = os.environ.get(
    'DATABASE_URL',
    'postgresql://***REMOVED***:***REMOVED***@localhost:5434/scpper-cn'
)

INDEX_BASE = 100.0
INDEX_K = 0.20
SCORE_CLAMP = 3.476099
INFLATION_ALPHA = 0.50
MIN_Z_HISTORY = 8
SENTIMENT_ALPHA = 2.0
SENTIMENT_BETA = 2.0
SENTIMENT_K = 100.0
VOTE_K = 300.0
DEL_RATE_PENALTY = 0.05
Z_CLAMP = 6.0
DRIFT_WINDOW_WEEKS = int(os.environ.get('DRIFT_WINDOW_WEEKS', '26'))
DRIFT_MIN_HISTORY_WEEKS = int(os.environ.get('DRIFT_MIN_HISTORY_WEEKS', '8'))
DRIFT_BETA_OVERALL = float(os.environ.get('DRIFT_BETA_OVERALL', '0.95'))
DRIFT_BETA_OTHERS = float(os.environ.get('DRIFT_BETA_OTHERS', '0.20'))
DRIFT_BETA_TRANSLATION = float(os.environ.get('DRIFT_BETA_TRANSLATION', '0.70'))
HOURLY_TICKS_PER_DAY = int(os.environ.get('HOURLY_TICKS_PER_DAY', '24'))

ANOMALY_START = pd.Timestamp('2022-04-01')
ANOMALY_END = pd.Timestamp('2022-07-31')
ANOMALY_RZ_THRESHOLD = 4.0

# Historical bootstrap-only vote backfill redistribution.
# Set VOTE_BACKFILL_MODE=off for incremental/new-data runs.
VOTE_BACKFILL_MODE = os.environ.get('VOTE_BACKFILL_MODE', 'bootstrap').strip().lower()
BACKFILL_REDIS_START = pd.Timestamp('2021-01-01')
BACKFILL_REDIS_END = pd.Timestamp('2022-12-31')
BACKFILL_HISTORY_WEEKS = 12
BACKFILL_MIN_NONZERO_HISTORY = 4
BACKFILL_SPIKE_FACTOR = 2.5
BACKFILL_SPIKE_ABS_MIN = 500.0
BACKFILL_PREV_ZERO_MAX = 1e-9

DAILY_BACKFILL_HISTORY_DAYS = 36
DAILY_BACKFILL_MIN_NONZERO_HISTORY = 10
DAILY_BACKFILL_PREV_RATIO_MAX = 0.22
DAILY_BACKFILL_MIN_GAP_DAYS = 3
DAILY_BACKFILL_FACTOR_REV = 1.25
DAILY_BACKFILL_ABS_MIN_REV = 60.0
DAILY_BACKFILL_FACTOR_VOTES = 2.50
DAILY_BACKFILL_ABS_MIN_VOTES = 500.0

OUT_DIR = Path('docs/plots/v0.2.1-kline')
CALC_START_DATE = pd.Timestamp(os.environ.get('CALC_START_DATE', '2023-01-01')).normalize()
WARMUP_START_DATE = pd.Timestamp(os.environ.get('WARMUP_START_DATE', '2022-10-01')).normalize()
MIN_WARMUP_DAYS = int(os.environ.get('MIN_WARMUP_DAYS', '92'))


def run_sql_df(sql: str) -> pd.DataFrame:
  cmd = [
    PSQL_BIN,
    DB_URL,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    f'COPY ({sql}) TO STDOUT WITH CSV HEADER'
  ]
  out = subprocess.check_output(cmd, text=True)
  return pd.read_csv(io.StringIO(out))


def fetch_time_bounds() -> tuple[str, str, str]:
  sql = """
SELECT
  MIN(date)::date AS start_date,
  MAX(date)::date AS end_date
FROM "PageDailyStats"
"""
  df = run_sql_df(sql)
  if df.empty or pd.isna(df.loc[0, 'start_date']) or pd.isna(df.loc[0, 'end_date']):
    raise RuntimeError('PageDailyStats has no usable date range')
  start_day = pd.to_datetime(df.loc[0, 'start_date']).normalize()
  end_day = pd.to_datetime(df.loc[0, 'end_date']).normalize()
  start_week = (start_day - pd.to_timedelta(start_day.weekday(), unit='D')).normalize()
  return (
    start_day.strftime('%Y-%m-%d'),
    start_week.strftime('%Y-%m-%d'),
    end_day.strftime('%Y-%m-%d')
  )


def fetch_daily_metrics(start_date: str, end_date: str) -> pd.DataFrame:
  sql = f"""
WITH pds_with_tags AS (
  SELECT
    pds.date::date AS day,
    pds.revisions::numeric AS revisions,
    pds.votes_up::numeric AS votes_up,
    pds.votes_down::numeric AS votes_down,
    COALESCE(pv.tags, ARRAY[]::text[]) AS tags
  FROM "PageDailyStats" pds
  LEFT JOIN LATERAL (
    SELECT pv.tags
    FROM "PageVersion" pv
    WHERE pv."pageId" = pds."pageId"
      AND pv."validFrom" <= (pds.date::timestamp + INTERVAL '1 day' - INTERVAL '1 second')
      AND (pv."validTo" IS NULL OR pv."validTo" > (pds.date::timestamp + INTERVAL '1 day' - INTERVAL '1 second'))
    ORDER BY pv."validFrom" DESC, pv.id DESC
    LIMIT 1
  ) pv ON true
  WHERE pds.date::date >= DATE '{start_date}'
    AND pds.date::date <= DATE '{end_date}'
),
pds_daily AS (
  SELECT
    p.day,
    cat.category,
    SUM(p.revisions)::numeric AS rev_raw,
    SUM(p.votes_up)::numeric AS up_raw,
    SUM(p.votes_down)::numeric AS down_raw
  FROM pds_with_tags p
  JOIN LATERAL (
    SELECT unnest(ARRAY[
      'OVERALL'::text,
      CASE WHEN NOT ('原创' = ANY(p.tags)) THEN 'TRANSLATION'::text END,
      CASE WHEN ('原创' = ANY(p.tags) AND 'scp' = ANY(p.tags)) THEN 'SCP'::text END,
      CASE WHEN ('原创' = ANY(p.tags) AND '故事' = ANY(p.tags)) THEN 'TALE'::text END,
      CASE WHEN ('原创' = ANY(p.tags) AND 'goi格式' = ANY(p.tags)) THEN 'GOI'::text END,
      CASE WHEN ('原创' = ANY(p.tags) AND 'wanderers' = ANY(p.tags)) THEN 'WANDERERS'::text END
    ]) AS category
  ) cat ON cat.category IS NOT NULL
  GROUP BY 1, 2
),
first_revision_ts AS (
  SELECT
    pv."pageId" AS page_id,
    MIN(r.timestamp) FILTER (WHERE r.type = 'PAGE_CREATED') AS first_page_created_ts,
    MIN(r.timestamp) AS first_revision_ts
  FROM "PageVersion" pv
  LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
  GROUP BY 1
),
page_publish AS (
  SELECT
    p.id AS page_id,
    CASE
      WHEN p."firstPublishedAt" IS NOT NULL
       AND COALESCE(fr.first_page_created_ts, fr.first_revision_ts) IS NOT NULL
      THEN LEAST(p."firstPublishedAt", COALESCE(fr.first_page_created_ts, fr.first_revision_ts))
      ELSE COALESCE(p."firstPublishedAt", fr.first_page_created_ts, fr.first_revision_ts)
    END AS published_at
  FROM "Page" p
  LEFT JOIN first_revision_ts fr ON fr.page_id = p.id
),
new_with_tags AS (
  SELECT
    pp.published_at::date AS day,
    COALESCE(pv.tags, ARRAY[]::text[]) AS tags
  FROM page_publish pp
  LEFT JOIN LATERAL (
    SELECT pv.tags
    FROM "PageVersion" pv
    WHERE pv."pageId" = pp.page_id
      AND pv."validFrom" <= pp.published_at
      AND (pv."validTo" IS NULL OR pv."validTo" > pp.published_at)
    ORDER BY pv."validFrom" DESC, pv.id DESC
    LIMIT 1
  ) pv ON true
  WHERE pp.published_at IS NOT NULL
    AND pp.published_at::date >= DATE '{start_date}'
    AND pp.published_at::date <= DATE '{end_date}'
),
new_events AS (
  SELECT
    n.day,
    cat.category,
    COUNT(*)::numeric AS new_cnt
  FROM new_with_tags n
  JOIN LATERAL (
    SELECT unnest(ARRAY[
      'OVERALL'::text,
      CASE WHEN NOT ('原创' = ANY(n.tags)) THEN 'TRANSLATION'::text END,
      CASE WHEN ('原创' = ANY(n.tags) AND 'scp' = ANY(n.tags)) THEN 'SCP'::text END,
      CASE WHEN ('原创' = ANY(n.tags) AND '故事' = ANY(n.tags)) THEN 'TALE'::text END,
      CASE WHEN ('原创' = ANY(n.tags) AND 'goi格式' = ANY(n.tags)) THEN 'GOI'::text END,
      CASE WHEN ('原创' = ANY(n.tags) AND 'wanderers' = ANY(n.tags)) THEN 'WANDERERS'::text END
    ]) AS category
  ) cat ON cat.category IS NOT NULL
  GROUP BY 1, 2
),
deleted_events_raw AS (
  SELECT
    t.day,
    COALESCE(t.tags, ARRAY[]::text[]) AS tags,
    1::numeric AS del_cnt
  FROM (
    SELECT
      pv."validFrom"::date AS day,
      pv.tags,
      pv."isDeleted" AS is_deleted,
      LAG(pv."isDeleted") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom") AS prev_deleted
    FROM "PageVersion" pv
  ) t
  WHERE t.day >= DATE '{start_date}'
    AND t.day <= DATE '{end_date}'
    AND t.is_deleted = true
    AND COALESCE(t.prev_deleted, false) = false
),
deleted_events AS (
  SELECT
    d.day,
    cat.category,
    SUM(d.del_cnt)::numeric AS del_cnt
  FROM deleted_events_raw d
  JOIN LATERAL (
    SELECT unnest(ARRAY[
      'OVERALL'::text,
      CASE WHEN NOT ('原创' = ANY(d.tags)) THEN 'TRANSLATION'::text END,
      CASE WHEN ('原创' = ANY(d.tags) AND 'scp' = ANY(d.tags)) THEN 'SCP'::text END,
      CASE WHEN ('原创' = ANY(d.tags) AND '故事' = ANY(d.tags)) THEN 'TALE'::text END,
      CASE WHEN ('原创' = ANY(d.tags) AND 'goi格式' = ANY(d.tags)) THEN 'GOI'::text END,
      CASE WHEN ('原创' = ANY(d.tags) AND 'wanderers' = ANY(d.tags)) THEN 'WANDERERS'::text END
    ]) AS category
  ) cat ON cat.category IS NOT NULL
  GROUP BY 1, 2
),
days AS (
  SELECT generate_series(
    DATE '{start_date}',
    DATE '{end_date}',
    INTERVAL '1 day'
  )::date AS day
),
cats AS (
  SELECT * FROM (VALUES
    ('OVERALL'::text),
    ('TRANSLATION'::text),
    ('SCP'::text),
    ('TALE'::text),
    ('GOI'::text),
    ('WANDERERS'::text)
  ) x(category)
),
grid AS (
  SELECT d.day, c.category
  FROM days d
  CROSS JOIN cats c
)
SELECT
  g.day,
  g.category,
  COALESCE(p.rev_raw, 0)::numeric AS rev_raw,
  COALESCE(p.up_raw, 0)::numeric AS up_raw,
  COALESCE(p.down_raw, 0)::numeric AS down_raw,
  COALESCE(n.new_cnt, 0)::numeric AS new_cnt,
  COALESCE(de.del_cnt, 0)::numeric AS del_cnt
FROM grid g
LEFT JOIN pds_daily p ON p.day = g.day AND p.category = g.category
LEFT JOIN new_events n ON n.day = g.day AND n.category = g.category
LEFT JOIN deleted_events de ON de.day = g.day AND de.category = g.category
ORDER BY g.day, g.category
"""
  df = run_sql_df(sql)
  df['day'] = pd.to_datetime(df['day'])
  return df


def fetch_page_count_start(start_week: str, end_date: str) -> pd.DataFrame:
  sql = f"""
WITH weeks AS (
  SELECT generate_series(
    DATE '{start_week}',
    date_trunc('week', DATE '{end_date}'::timestamp)::date,
    INTERVAL '7 day'
  )::date AS week_start
),
snap AS (
  SELECT
    w.week_start,
    pv."pageId" AS page_id,
    pv.tags
  FROM weeks w
  JOIN "PageVersion" pv
    ON pv."validFrom" <= w.week_start::timestamp
   AND (pv."validTo" IS NULL OR pv."validTo" > w.week_start::timestamp)
   AND pv."isDeleted" = false
),
counts AS (
  SELECT week_start, 'OVERALL'::text AS category, COUNT(DISTINCT page_id)::numeric AS page_count_start FROM snap GROUP BY 1
  UNION ALL
  SELECT week_start, 'TRANSLATION', COUNT(DISTINCT page_id)::numeric FROM snap WHERE NOT ('原创' = ANY(tags)) GROUP BY 1
  UNION ALL
  SELECT week_start, 'SCP', COUNT(DISTINCT page_id)::numeric FROM snap WHERE '原创' = ANY(tags) AND 'scp' = ANY(tags) GROUP BY 1
  UNION ALL
  SELECT week_start, 'TALE', COUNT(DISTINCT page_id)::numeric FROM snap WHERE '原创' = ANY(tags) AND '故事' = ANY(tags) GROUP BY 1
  UNION ALL
  SELECT week_start, 'GOI', COUNT(DISTINCT page_id)::numeric FROM snap WHERE '原创' = ANY(tags) AND 'goi格式' = ANY(tags) GROUP BY 1
  UNION ALL
  SELECT week_start, 'WANDERERS', COUNT(DISTINCT page_id)::numeric FROM snap WHERE '原创' = ANY(tags) AND 'wanderers' = ANY(tags) GROUP BY 1
)
SELECT week_start, category, page_count_start
FROM counts
ORDER BY week_start, category
"""
  df = run_sql_df(sql)
  df['week_start'] = pd.to_datetime(df['week_start'])
  return df


def compute_daily_scale(overall: pd.DataFrame) -> pd.DataFrame:
  overall = overall.sort_values('day').copy()
  days = overall['day'].tolist()
  votes = overall['votes_raw'].astype(float).to_numpy()

  scales = np.ones(len(overall), dtype=float)
  rz_vals = np.zeros(len(overall), dtype=float)
  cap_vals = votes.copy()

  for i, day in enumerate(days):
    mask = (overall['day'] >= day - pd.Timedelta(days=30)) & (overall['day'] <= day + pd.Timedelta(days=30))
    mask.iloc[i] = False
    win = votes[mask.to_numpy()]
    if win.size < 15:
      continue
    lv = np.log1p(win)
    med = np.median(lv)
    mad = np.median(np.abs(lv - med))
    if mad <= 1e-12:
      continue
    lv_i = np.log1p(votes[i])
    rz = 0.6745 * (lv_i - med) / mad
    cap = max(np.exp(med + (4.0 / 0.6745) * mad) - 1.0, 0.0)
    rz_vals[i] = rz
    cap_vals[i] = cap
    if ANOMALY_START <= day <= ANOMALY_END and rz >= ANOMALY_RZ_THRESHOLD and votes[i] > 0:
      adj = min(votes[i], cap)
      scales[i] = adj / votes[i]

  overall['rz_local'] = rz_vals
  overall['cap_votes'] = cap_vals
  overall['scale'] = scales
  overall['votes_adj'] = overall['votes_raw'] * overall['scale']
  return overall


def redistribute_daily_backfill_days(daily: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
  # Only used in historical bootstrap stage.
  if VOTE_BACKFILL_MODE != 'bootstrap':
    return daily, pd.DataFrame(columns=[
      'category', 'metric', 'backfill_day', 'original_value', 'baseline_value',
      'redistributed_value', 'prev_days_count', 'add_per_prev_day',
      'prev_day_value', 'hist_median_value', 'threshold_value', 'up_ratio_used',
      'gap_days_count', 'gap_fill_amount'
    ])

  df = daily.copy().sort_values(['category', 'day'])
  logs = []

  def _detect_and_redistribute_series(
    arr: np.ndarray,
    days: np.ndarray,
    metric: str,
    spike_factor: float,
    abs_min: float
  ) -> tuple[np.ndarray, list[dict]]:
    out = arr.copy()
    metric_logs: list[dict] = []
    n = len(out)
    for i in range(1, n - 1):
      day_ts = pd.Timestamp(days[i])
      if day_ts < BACKFILL_REDIS_START or day_ts > BACKFILL_REDIS_END:
        continue

      hist = out[max(0, i - DAILY_BACKFILL_HISTORY_DAYS):i]
      hist_nonzero = hist[hist > BACKFILL_PREV_ZERO_MAX]
      if hist_nonzero.size < DAILY_BACKFILL_MIN_NONZERO_HISTORY:
        continue

      hist_med = float(np.median(hist_nonzero))
      prev_limit = max(BACKFILL_PREV_ZERO_MAX, hist_med * DAILY_BACKFILL_PREV_RATIO_MAX)
      threshold = max(abs_min, hist_med * spike_factor)

      prev_v = float(out[i - 1])
      cur_v = float(out[i])
      next_v = float(out[i + 1])
      if prev_v > prev_limit:
        continue
      gap_len = 0
      j = i - 1
      while j >= 0 and float(out[j]) <= prev_limit:
        gap_len += 1
        j -= 1
      if gap_len < DAILY_BACKFILL_MIN_GAP_DAYS:
        continue
      if cur_v < threshold:
        continue
      if next_v <= prev_limit:
        continue

      baseline = min(cur_v, max(hist_med, prev_limit))
      redistributed = cur_v - baseline
      if redistributed <= BACKFILL_PREV_ZERO_MAX:
        continue
      if i <= 0:
        continue

      gap_start = j + 1
      gap_idx = np.arange(gap_start, i, dtype=int)
      gap_fill_amount = 0.0
      if gap_idx.size > 0 and redistributed > BACKFILL_PREV_ZERO_MAX and prev_limit > BACKFILL_PREV_ZERO_MAX:
        gap_deficit = np.maximum(prev_limit - out[gap_idx], 0.0)
        total_gap_deficit = float(gap_deficit.sum())
        if total_gap_deficit > BACKFILL_PREV_ZERO_MAX:
          gap_fill_amount = min(redistributed, total_gap_deficit)
          out[gap_idx] = out[gap_idx] + gap_deficit * (gap_fill_amount / total_gap_deficit)
          redistributed -= gap_fill_amount

      add_per_prev = redistributed / i if redistributed > BACKFILL_PREV_ZERO_MAX else 0.0
      if add_per_prev > 0:
        out[:i] = out[:i] + add_per_prev
      out[i] = baseline

      metric_logs.append({
        'metric': metric,
        'backfill_day': day_ts,
        'original_value': cur_v,
        'baseline_value': baseline,
        'redistributed_value': redistributed,
        'prev_days_count': i,
        'add_per_prev_day': add_per_prev,
        'prev_day_value': prev_v,
        'hist_median_value': hist_med,
        'threshold_value': threshold,
        'up_ratio_used': np.nan,
        'gap_days_count': int(gap_idx.size),
        'gap_fill_amount': gap_fill_amount
      })

    return out, metric_logs

  for category, g0 in df.groupby('category', sort=False):
    g = g0.sort_values('day').copy()
    days = g['day'].to_numpy()

    rev_arr = g['rev_raw'].to_numpy(dtype=float)
    rev_arr_new, rev_logs = _detect_and_redistribute_series(
      rev_arr,
      days,
      metric='rev_raw',
      spike_factor=DAILY_BACKFILL_FACTOR_REV,
      abs_min=DAILY_BACKFILL_ABS_MIN_REV
    )
    g['rev_raw'] = rev_arr_new
    for row in rev_logs:
      row['category'] = category
      logs.append(row)

    up_arr = g['up_adj'].to_numpy(dtype=float)
    down_arr = g['down_adj'].to_numpy(dtype=float)
    votes_arr = up_arr + down_arr

    n = len(votes_arr)
    for i in range(1, n - 1):
      day_ts = pd.Timestamp(days[i])
      if day_ts < BACKFILL_REDIS_START or day_ts > BACKFILL_REDIS_END:
        continue

      hist = votes_arr[max(0, i - DAILY_BACKFILL_HISTORY_DAYS):i]
      hist_nonzero = hist[hist > BACKFILL_PREV_ZERO_MAX]
      if hist_nonzero.size < DAILY_BACKFILL_MIN_NONZERO_HISTORY:
        continue

      hist_med = float(np.median(hist_nonzero))
      prev_limit = max(BACKFILL_PREV_ZERO_MAX, hist_med * DAILY_BACKFILL_PREV_RATIO_MAX)
      threshold = max(DAILY_BACKFILL_ABS_MIN_VOTES, hist_med * DAILY_BACKFILL_FACTOR_VOTES)

      prev_v = float(votes_arr[i - 1])
      cur_v = float(votes_arr[i])
      next_v = float(votes_arr[i + 1])
      if prev_v > prev_limit:
        continue
      gap_len = 0
      j = i - 1
      while j >= 0 and float(votes_arr[j]) <= prev_limit:
        gap_len += 1
        j -= 1
      if gap_len < DAILY_BACKFILL_MIN_GAP_DAYS:
        continue
      if cur_v < threshold:
        continue
      if next_v <= prev_limit:
        continue

      baseline = min(cur_v, max(hist_med, prev_limit))
      redistributed = cur_v - baseline
      if redistributed <= BACKFILL_PREV_ZERO_MAX:
        continue
      if i <= 0:
        continue

      up_ratio = float(up_arr[i] / cur_v) if cur_v > BACKFILL_PREV_ZERO_MAX else 0.9
      up_ratio = min(max(up_ratio, 0.0), 1.0)
      down_ratio = 1.0 - up_ratio
      gap_start = j + 1
      gap_idx = np.arange(gap_start, i, dtype=int)
      gap_fill_amount = 0.0
      if gap_idx.size > 0 and redistributed > BACKFILL_PREV_ZERO_MAX and prev_limit > BACKFILL_PREV_ZERO_MAX:
        gap_deficit = np.maximum(prev_limit - votes_arr[gap_idx], 0.0)
        total_gap_deficit = float(gap_deficit.sum())
        if total_gap_deficit > BACKFILL_PREV_ZERO_MAX:
          gap_fill_amount = min(redistributed, total_gap_deficit)
          alloc = gap_deficit * (gap_fill_amount / total_gap_deficit)
          up_arr[gap_idx] = up_arr[gap_idx] + alloc * up_ratio
          down_arr[gap_idx] = down_arr[gap_idx] + alloc * down_ratio
          redistributed -= gap_fill_amount

      add_per_prev = redistributed / i if redistributed > BACKFILL_PREV_ZERO_MAX else 0.0
      if add_per_prev > 0:
        up_arr[:i] = up_arr[:i] + add_per_prev * up_ratio
        down_arr[:i] = down_arr[:i] + add_per_prev * down_ratio
      up_arr[i] = baseline * up_ratio
      down_arr[i] = baseline * down_ratio
      votes_arr = up_arr + down_arr

      logs.append({
        'category': category,
        'metric': 'votes_total_adj_raw',
        'backfill_day': day_ts,
        'original_value': cur_v,
        'baseline_value': baseline,
        'redistributed_value': redistributed,
        'prev_days_count': i,
        'add_per_prev_day': add_per_prev,
        'prev_day_value': prev_v,
        'hist_median_value': hist_med,
        'threshold_value': threshold,
        'up_ratio_used': up_ratio,
        'gap_days_count': int(gap_idx.size),
        'gap_fill_amount': gap_fill_amount
      })

    g['up_adj'] = up_arr
    g['down_adj'] = down_arr
    g['votes_total_adj_raw'] = up_arr + down_arr
    df.loc[g.index, ['rev_raw', 'up_adj', 'down_adj', 'votes_total_adj_raw']] = g[['rev_raw', 'up_adj', 'down_adj', 'votes_total_adj_raw']]

  log_df = pd.DataFrame(logs)
  if not log_df.empty:
    log_df = log_df.sort_values(['category', 'metric', 'backfill_day']).reset_index(drop=True)

  return df, log_df


def redistribute_vote_backfill_weeks(daily: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
  # Only used in historical bootstrap stage.
  if VOTE_BACKFILL_MODE != 'bootstrap':
    return daily, pd.DataFrame(columns=[
      'category', 'backfill_week', 'original_votes_week', 'baseline_votes_week',
      'redistributed_votes', 'prev_weeks_count', 'add_per_prev_week',
      'prev_week_votes', 'hist_median_votes', 'threshold_votes', 'up_ratio_used'
    ])

  df = daily.copy().sort_values(['category', 'day'])
  df['week_start'] = df['day'] - pd.to_timedelta(df['day'].dt.weekday, unit='D')
  logs = []

  for category, g0 in df.groupby('category', sort=False):
    g = g0.sort_values('day').copy()

    def weekly_view(frame: pd.DataFrame) -> pd.DataFrame:
      return frame.groupby('week_start', as_index=False).agg(
        votes_week=('votes_total_adj_raw', 'sum'),
        up_week=('up_adj', 'sum'),
        down_week=('down_adj', 'sum'),
        day_count=('day', 'size')
      ).sort_values('week_start').reset_index(drop=True)

    wk_base = weekly_view(g)
    votes_arr = wk_base['votes_week'].to_numpy(dtype=float)
    weeks_arr = wk_base['week_start'].to_numpy()
    candidates: list[tuple[pd.Timestamp, float, float, float, float]] = []

    for i in range(1, len(wk_base) - 1):
      week_ts = pd.Timestamp(weeks_arr[i])
      if week_ts < BACKFILL_REDIS_START or week_ts > BACKFILL_REDIS_END:
        continue
      prev_votes = float(votes_arr[i - 1])
      if prev_votes > BACKFILL_PREV_ZERO_MAX:
        continue

      hist = votes_arr[max(0, i - BACKFILL_HISTORY_WEEKS):i]
      hist_nonzero = hist[hist > BACKFILL_PREV_ZERO_MAX]
      if hist_nonzero.size < BACKFILL_MIN_NONZERO_HISTORY:
        continue

      hist_med = float(np.median(hist_nonzero))
      threshold = max(BACKFILL_SPIKE_ABS_MIN, hist_med * BACKFILL_SPIKE_FACTOR)
      cur_votes = float(votes_arr[i])
      next_votes = float(votes_arr[i + 1])
      if cur_votes < threshold:
        continue
      if next_votes <= BACKFILL_PREV_ZERO_MAX:
        continue

      candidates.append((week_ts, hist_med, threshold, prev_votes, cur_votes))

    if not candidates:
      continue

    total_votes = float(g['votes_total_adj_raw'].sum())
    total_up = float(g['up_adj'].sum())
    fallback_up_ratio = (total_up / total_votes) if total_votes > BACKFILL_PREV_ZERO_MAX else 0.9

    for week_ts, hist_med, threshold, prev_votes, orig_candidate_votes in candidates:
      wk = weekly_view(g)
      match = wk.index[wk['week_start'] == week_ts]
      if len(match) == 0:
        continue

      i = int(match[0])
      original_votes_week = float(wk.loc[i, 'votes_week'])
      if original_votes_week <= BACKFILL_PREV_ZERO_MAX or i <= 0:
        continue

      baseline_votes_week = min(original_votes_week, max(0.0, hist_med))
      redistributed_votes = original_votes_week - baseline_votes_week
      if redistributed_votes <= BACKFILL_PREV_ZERO_MAX:
        continue

      prev_weeks_count = i
      add_per_prev_week = redistributed_votes / prev_weeks_count
      up_ratio = (
        float(wk.loc[i, 'up_week']) / original_votes_week
        if original_votes_week > BACKFILL_PREV_ZERO_MAX else fallback_up_ratio
      )
      up_ratio = min(max(up_ratio, 0.0), 1.0)
      down_ratio = 1.0 - up_ratio

      cur_mask = g['week_start'] == week_ts
      cur_total_from_daily = float(g.loc[cur_mask, 'votes_total_adj_raw'].sum())
      if cur_total_from_daily <= BACKFILL_PREV_ZERO_MAX:
        continue
      cur_factor = baseline_votes_week / cur_total_from_daily
      g.loc[cur_mask, 'up_adj'] = g.loc[cur_mask, 'up_adj'] * cur_factor
      g.loc[cur_mask, 'down_adj'] = g.loc[cur_mask, 'down_adj'] * cur_factor

      for j in range(prev_weeks_count):
        prev_week_ts = wk.loc[j, 'week_start']
        prev_mask = g['week_start'] == prev_week_ts
        day_count = int(prev_mask.sum())
        if day_count <= 0:
          continue
        add_per_day = add_per_prev_week / day_count
        g.loc[prev_mask, 'up_adj'] = g.loc[prev_mask, 'up_adj'] + add_per_day * up_ratio
        g.loc[prev_mask, 'down_adj'] = g.loc[prev_mask, 'down_adj'] + add_per_day * down_ratio

      logs.append({
        'category': category,
        'backfill_week': week_ts,
        'original_votes_week': original_votes_week,
        'baseline_votes_week': baseline_votes_week,
        'redistributed_votes': redistributed_votes,
        'prev_weeks_count': prev_weeks_count,
        'add_per_prev_week': add_per_prev_week,
        'prev_week_votes': prev_votes,
        'hist_median_votes': hist_med,
        'threshold_votes': threshold,
        'up_ratio_used': up_ratio
      })

    g['votes_total_adj_raw'] = g['up_adj'] + g['down_adj']
    df.loc[g.index, ['up_adj', 'down_adj', 'votes_total_adj_raw']] = g[['up_adj', 'down_adj', 'votes_total_adj_raw']]

  log_df = pd.DataFrame(logs)
  if not log_df.empty:
    log_df = log_df.sort_values(['category', 'backfill_week']).reset_index(drop=True)

  return df.drop(columns=['week_start']), log_df


def add_prev_wtd(df: pd.DataFrame, col: str) -> pd.DataFrame:
  key = ['category', 'week_start', 'offset']
  lookup = df[key + [f'{col}_wtd']].rename(columns={
    'week_start': 'prev_week_start',
    f'{col}_wtd': f'{col}_wtd_prev'
  })
  return df.merge(lookup, on=['category', 'prev_week_start', 'offset'], how='left')


def signed_log(arr: pd.Series) -> pd.Series:
  return np.sign(arr) * np.log1p(np.abs(arr))


def expanding_z(df: pd.DataFrame, x_col: str, z_col: str, floor: float) -> pd.DataFrame:
  df = df.sort_values(['category', 'offset', 'day']).copy()

  def _per_group(g: pd.DataFrame) -> pd.DataFrame:
    x = g[x_col].astype(float)
    mean_prev = x.expanding().mean().shift(1)
    std_prev = x.expanding().std(ddof=1).shift(1)
    count_prev = x.expanding().count().shift(1).fillna(0.0)
    denom = np.maximum(std_prev.fillna(0.0), floor)
    z_raw = (x - mean_prev) / denom
    z_raw = z_raw.where(mean_prev.notna(), 0.0)
    # Cold-start guard: avoid clamp hits before enough same-offset history.
    z_raw = z_raw.where(count_prev >= MIN_Z_HISTORY, 0.0)
    g[z_col] = z_raw.clip(-Z_CLAMP, Z_CLAMP)
    return g

  parts = []
  for _, g in df.groupby(['category', 'offset'], sort=False):
    parts.append(_per_group(g))
  return pd.concat(parts, ignore_index=False).sort_index()


def compute_weights(weekly: pd.DataFrame) -> pd.DataFrame:
  weekly = weekly.sort_values(['category', 'week_start']).copy()
  weekly['net_raw'] = weekly['new_raw'] - weekly['del_raw']

  base = {
    'rev_raw': 0.22,
    'votes_total_adj_raw': 0.25,
    'net_raw': 0.20
  }
  sentiment_weight = 0.15
  growth_total = 1.0 - sentiment_weight

  rows = []
  for category, g in weekly.groupby('category', sort=False):
    g = g.reset_index(drop=True)
    for i in range(len(g)):
      w = g.iloc[max(0, i - 51): i + 1]
      wp = {}
      for k, b in base.items():
        ratio = (w[k].abs() > 0).mean()
        wp[k] = b * np.sqrt(ratio)
      s = sum(wp.values())
      if s <= 0:
        norm = {k: base[k] / sum(base.values()) for k in base}
      else:
        norm = {k: v / s for k, v in wp.items()}
      rows.append({
        'category': category,
        'week_start': g.loc[i, 'week_start'],
        'weight_rev': norm['rev_raw'] * growth_total,
        'weight_votesTotal': norm['votes_total_adj_raw'] * growth_total,
        'weight_netContent': norm['net_raw'] * growth_total,
        'weight_sentiment': sentiment_weight
      })
  return pd.DataFrame(rows)


def apply_score_drift_neutralization(daily: pd.DataFrame) -> pd.DataFrame:
  daily = daily.sort_values(['category', 'offset', 'day']).copy()
  parts = []

  for (category, _), g in daily.groupby(['category', 'offset'], sort=False):
    g = g.copy()
    score_ref = (
      g['score_raw']
      .rolling(DRIFT_WINDOW_WEEKS, min_periods=DRIFT_MIN_HISTORY_WEEKS)
      .median()
      .shift(1)
      .fillna(0.0)
    )
    if category == 'OVERALL':
      beta = DRIFT_BETA_OVERALL
    elif category == 'TRANSLATION':
      beta = DRIFT_BETA_TRANSLATION
    else:
      beta = DRIFT_BETA_OTHERS
    g['score_ref'] = score_ref
    g['score_centered'] = g['score_raw'] - beta * score_ref
    g['score'] = g['score_centered'].clip(-SCORE_CLAMP, SCORE_CLAMP)
    parts.append(g)

  return pd.concat(parts, ignore_index=False).sort_index()


def build_hourly_forecast_ticks(daily: pd.DataFrame) -> pd.DataFrame:
  # Forecast is a separate visualization/projection series.
  # It is not the Oracle settlement/liquidation truth source.
  rows = []

  for category, g in daily.groupby('category', sort=False):
    g = g.sort_values('day').copy()
    prev_close = INDEX_BASE
    prev_score = 0.0

    for _, row in g.iterrows():
      day = pd.Timestamp(row['day'])
      day_close = float(row['index'])
      day_score = float(row['score'])
      week_start = pd.Timestamp(row['week_start'])

      if prev_close <= 0 or day_close <= 0:
        log_ratio = 0.0
      else:
        log_ratio = float(np.log(day_close / prev_close))
      score_delta = day_score - prev_score

      for hour in range(1, HOURLY_TICKS_PER_DAY + 1):
        u = hour / HOURLY_TICKS_PER_DAY
        rows.append({
          'category': category,
          'week_start': week_start,
          'settle_day': day,
          'hour_offset': hour,
          'as_of_ts': day + pd.Timedelta(hours=hour),
          'forecast_score': prev_score + score_delta * u,
          'forecast_index': prev_close * np.exp(log_ratio * u),
          'day_close_score': day_score,
          'day_close_index': day_close,
          'prev_day_close_index': prev_close
        })

      prev_close = day_close
      prev_score = day_score

  return pd.DataFrame(rows)


def build_anchor_consistency_report(
  hourly: pd.DataFrame,
  daily: pd.DataFrame,
  ohlc: pd.DataFrame
) -> pd.DataFrame:
  day_close = hourly[hourly['hour_offset'] == HOURLY_TICKS_PER_DAY][[
    'category', 'settle_day', 'forecast_index', 'forecast_score'
  ]].copy()
  day_close = day_close.rename(columns={
    'settle_day': 'day',
    'forecast_index': 'hourly_day_close_index',
    'forecast_score': 'hourly_day_close_score'
  })

  daily_cmp = daily[['category', 'day', 'index', 'score']].rename(columns={
    'index': 'daily_close_index',
    'score': 'daily_close_score'
  })
  day_merge = day_close.merge(daily_cmp, on=['category', 'day'], how='inner')
  day_merge['abs_diff_index'] = (day_merge['hourly_day_close_index'] - day_merge['daily_close_index']).abs()
  day_merge['abs_diff_score'] = (day_merge['hourly_day_close_score'] - day_merge['daily_close_score']).abs()

  weekly_hourly = (
    hourly.sort_values(['category', 'week_start', 'as_of_ts'])
    .groupby(['category', 'week_start'], as_index=False)
    .tail(1)
    [['category', 'week_start', 'forecast_index']]
    .rename(columns={'forecast_index': 'hourly_week_close_index'})
  )
  weekly_merge = weekly_hourly.merge(
    ohlc[['category', 'week_start', 'close']].rename(columns={'close': 'weekly_close_index'}),
    on=['category', 'week_start'],
    how='inner'
  )
  weekly_merge['abs_diff_index'] = (weekly_merge['hourly_week_close_index'] - weekly_merge['weekly_close_index']).abs()

  summary = pd.DataFrame([
    {
      'check': 'day_close_index',
      'max_abs_diff': float(day_merge['abs_diff_index'].max()) if not day_merge.empty else 0.0,
      'p99_abs_diff': float(day_merge['abs_diff_index'].quantile(0.99)) if not day_merge.empty else 0.0,
      'rows': int(len(day_merge))
    },
    {
      'check': 'day_close_score',
      'max_abs_diff': float(day_merge['abs_diff_score'].max()) if not day_merge.empty else 0.0,
      'p99_abs_diff': float(day_merge['abs_diff_score'].quantile(0.99)) if not day_merge.empty else 0.0,
      'rows': int(len(day_merge))
    },
    {
      'check': 'week_close_index',
      'max_abs_diff': float(weekly_merge['abs_diff_index'].max()) if not weekly_merge.empty else 0.0,
      'p99_abs_diff': float(weekly_merge['abs_diff_index'].quantile(0.99)) if not weekly_merge.empty else 0.0,
      'rows': int(len(weekly_merge))
    }
  ])
  return summary


def draw_candles(ohlc: pd.DataFrame, title: str, out_path: Path) -> None:
  fig, ax = plt.subplots(figsize=(16, 6))
  x = np.arange(len(ohlc))
  opens = ohlc['open'].to_numpy()
  highs = ohlc['high'].to_numpy()
  lows = ohlc['low'].to_numpy()
  closes = ohlc['close'].to_numpy()

  for i in range(len(ohlc)):
    color = '#16a34a' if closes[i] >= opens[i] else '#dc2626'
    ax.vlines(i, lows[i], highs[i], color=color, linewidth=1.0, alpha=0.9)
    low_body = min(opens[i], closes[i])
    body_h = max(abs(closes[i] - opens[i]), 1e-6)
    ax.add_patch(Rectangle((i - 0.32, low_body), 0.64, body_h, facecolor=color, edgecolor=color, alpha=0.8))

  tick_step = max(1, len(ohlc) // 12)
  tick_idx = np.arange(0, len(ohlc), tick_step)
  tick_labels = [pd.to_datetime(ohlc.iloc[i]['week_start']).strftime('%Y-%m') for i in tick_idx]
  ax.set_xticks(tick_idx)
  ax.set_xticklabels(tick_labels, rotation=0)

  ax.set_title(title)
  ax.set_ylabel('Index')
  ax.grid(alpha=0.18, linestyle='--', linewidth=0.7)
  fig.tight_layout()
  fig.savefig(out_path, dpi=170)
  plt.close(fig)


def main() -> None:
  OUT_DIR.mkdir(parents=True, exist_ok=True)

  if WARMUP_START_DATE > CALC_START_DATE:
    raise ValueError(f'WARMUP_START_DATE({WARMUP_START_DATE.date()}) must be <= CALC_START_DATE({CALC_START_DATE.date()})')

  db_start_date, _, end_date = fetch_time_bounds()
  db_start_day = pd.Timestamp(db_start_date).normalize()
  end_day = pd.Timestamp(end_date).normalize()

  data_start_day = max(db_start_day, WARMUP_START_DATE)
  calc_start_day = max(CALC_START_DATE, data_start_day)
  warmup_days = int((calc_start_day - data_start_day).days)
  if warmup_days < MIN_WARMUP_DAYS:
    calc_start_day = data_start_day + pd.Timedelta(days=MIN_WARMUP_DAYS)

  if calc_start_day > end_day:
    raise RuntimeError(
      f'Effective CALC_START_DATE({calc_start_day.date()}) is beyond end_date({end_day.date()}); '
      'reduce MIN_WARMUP_DAYS or move start earlier.'
    )

  data_start_week = (data_start_day - pd.to_timedelta(data_start_day.weekday(), unit='D')).normalize()
  # Weekly K-line uses full weeks; start plotting from the first Monday on/after calc_start_day.
  output_start_week = (calc_start_day + pd.to_timedelta((7 - calc_start_day.weekday()) % 7, unit='D')).normalize()

  daily = fetch_daily_metrics(data_start_day.strftime('%Y-%m-%d'), end_day.strftime('%Y-%m-%d'))
  page_count_start = fetch_page_count_start(data_start_week.strftime('%Y-%m-%d'), end_day.strftime('%Y-%m-%d'))

  overall = daily[daily['category'] == 'OVERALL'][['day', 'up_raw', 'down_raw']].copy()
  overall['votes_raw'] = overall['up_raw'] + overall['down_raw']
  scale_df = compute_daily_scale(overall[['day', 'votes_raw']])
  scale_df[['day', 'votes_raw', 'cap_votes', 'votes_adj', 'scale', 'rz_local']].to_csv(
    OUT_DIR / 'overall_vote_scale_daily.csv',
    index=False
  )

  daily = daily.merge(scale_df[['day', 'scale']], on='day', how='left')
  daily['scale'] = daily['scale'].fillna(1.0)
  daily['up_adj'] = daily['up_raw'] * daily['scale']
  daily['down_adj'] = daily['down_raw'] * daily['scale']
  daily['votes_total_adj_raw'] = daily['up_adj'] + daily['down_adj']
  daily['rev_raw'] = daily['rev_raw'].astype(float)
  daily['up_adj'] = daily['up_adj'].astype(float)
  daily['down_adj'] = daily['down_adj'].astype(float)
  daily['votes_total_adj_raw'] = daily['votes_total_adj_raw'].astype(float)

  daily, daily_backfill_log = redistribute_daily_backfill_days(daily)
  daily_backfill_log.to_csv(OUT_DIR / 'daily_backfill_redistribution.csv', index=False)

  daily, backfill_log = redistribute_vote_backfill_weeks(daily)
  backfill_log.to_csv(OUT_DIR / 'vote_backfill_redistribution.csv', index=False)

  daily['week_start'] = daily['day'] - pd.to_timedelta(daily['day'].dt.weekday, unit='D')
  daily['offset'] = (daily['day'] - daily['week_start']).dt.days.astype(int)
  daily['prev_week_start'] = daily['week_start'] - pd.Timedelta(days=7)

  metric_cols = ['rev_raw', 'new_cnt', 'del_cnt', 'up_adj', 'down_adj', 'votes_total_adj_raw']
  daily = daily.sort_values(['category', 'day']).copy()
  for col in metric_cols:
    daily[f'{col}_wtd'] = daily.groupby(['category', 'week_start'])[col].cumsum()
    daily = add_prev_wtd(daily, col)
    daily[f'{col}_wtd_prev'] = daily[f'{col}_wtd_prev'].fillna(0.0)

  vote_cols = ['up_adj', 'down_adj', 'votes_total_adj_raw']
  for col in vote_cols:
    daily[f'{col}_wtd_eff'] = (
      daily.groupby(['category', 'week_start'])[f'{col}_wtd']
      .shift(1)
      .fillna(0.0)
    )
    daily[f'{col}_wtd_prev_eff'] = (
      daily.groupby(['category', 'week_start'])[f'{col}_wtd_prev']
      .shift(1)
      .fillna(0.0)
    )

  page_count_start = page_count_start.rename(columns={'page_count_start': 'page_count_start_cur'})
  daily = daily.merge(
    page_count_start[['week_start', 'category', 'page_count_start_cur']],
    on=['week_start', 'category'],
    how='left'
  )
  daily = daily.merge(
    page_count_start[['week_start', 'category', 'page_count_start_cur']].rename(
      columns={'week_start': 'prev_week_start', 'page_count_start_cur': 'page_count_start_prev'}
    ),
    on=['prev_week_start', 'category'],
    how='left'
  )
  daily['page_count_start_cur'] = daily['page_count_start_cur'].fillna(1.0)
  daily['page_count_start_prev'] = daily['page_count_start_prev'].fillna(daily['page_count_start_cur']).fillna(1.0)

  daily['approval_wtd'] = (daily['up_adj_wtd_eff'] + SENTIMENT_ALPHA) / (
    daily['up_adj_wtd_eff'] + daily['down_adj_wtd_eff'] + SENTIMENT_ALPHA + SENTIMENT_BETA
  )
  daily['approval_wtd_prev'] = (daily['up_adj_wtd_prev_eff'] + SENTIMENT_ALPHA) / (
    daily['up_adj_wtd_prev_eff'] + daily['down_adj_wtd_prev_eff'] + SENTIMENT_ALPHA + SENTIMENT_BETA
  )
  daily['approval_wtd'] = daily['approval_wtd'].clip(0.01, 0.99)
  daily['approval_wtd_prev'] = daily['approval_wtd_prev'].clip(0.01, 0.99)

  daily['sentiment_wtd'] = np.log(daily['approval_wtd'] / (1 - daily['approval_wtd']))
  daily['sentiment_wtd_prev'] = np.log(daily['approval_wtd_prev'] / (1 - daily['approval_wtd_prev']))

  daily['net_wtd'] = daily['new_cnt_wtd'] - daily['del_cnt_wtd']
  daily['net_wtd_prev'] = daily['new_cnt_wtd_prev'] - daily['del_cnt_wtd_prev']

  daily['del_rate_wtd'] = daily['del_cnt_wtd'] / np.maximum(1.0, daily['page_count_start_cur'])
  daily['del_rate_wtd_prev'] = daily['del_cnt_wtd_prev'] / np.maximum(1.0, daily['page_count_start_prev'])

  daily['d_rev'] = np.log1p(daily['rev_raw_wtd']) - np.log1p(daily['rev_raw_wtd_prev'])
  daily['d_votes'] = np.log1p(daily['votes_total_adj_raw_wtd_eff']) - np.log1p(daily['votes_total_adj_raw_wtd_prev_eff'])
  daily['d_net'] = signed_log(daily['net_wtd']) - signed_log(daily['net_wtd_prev'])
  daily['d_sent'] = daily['sentiment_wtd'] - daily['sentiment_wtd_prev']
  daily['d_delrate'] = np.log1p(daily['del_rate_wtd']) - np.log1p(daily['del_rate_wtd_prev'])

  overall_cols = ['day', 'd_rev', 'd_votes', 'd_net', 'd_sent', 'd_delrate']
  overall_daily = daily[daily['category'] == 'OVERALL'][overall_cols].rename(columns={
    'd_rev': 'd_rev_overall',
    'd_votes': 'd_votes_overall',
    'd_net': 'd_net_overall',
    'd_sent': 'd_sent_overall',
    'd_delrate': 'd_delrate_overall'
  })
  daily = daily.merge(overall_daily, on='day', how='left')

  is_overall = (daily['category'] == 'OVERALL')
  daily['x_rev'] = np.where(is_overall, daily['d_rev_overall'], daily['d_rev'] - INFLATION_ALPHA * daily['d_rev_overall'])
  daily['x_votes'] = np.where(is_overall, daily['d_votes_overall'], daily['d_votes'] - INFLATION_ALPHA * daily['d_votes_overall'])
  daily['x_net'] = np.where(is_overall, daily['d_net_overall'], daily['d_net'] - INFLATION_ALPHA * daily['d_net_overall'])
  daily['x_sent'] = np.where(is_overall, daily['d_sent_overall'], daily['d_sent'] - INFLATION_ALPHA * daily['d_sent_overall'])
  daily['x_delrate'] = np.where(is_overall, daily['d_delrate_overall'], daily['d_delrate'] - INFLATION_ALPHA * daily['d_delrate_overall'])

  daily = expanding_z(daily, 'x_rev', 'z_rev', 0.10)
  daily = expanding_z(daily, 'x_votes', 'z_votesTotal', 0.10)
  daily = expanding_z(daily, 'x_net', 'z_net', 0.10)
  daily = expanding_z(daily, 'x_sent', 'z_sent', 0.10)
  daily = expanding_z(daily, 'x_delrate', 'z_delRate', 0.05)

  daily['n_vote'] = daily['votes_total_adj_raw_wtd_eff'].clip(lower=0.0)
  daily['shrink_vote'] = np.sqrt(daily['n_vote'] / (daily['n_vote'] + VOTE_K))
  daily['z_votes_eff'] = daily['z_votesTotal'] * daily['shrink_vote']
  daily['shrink_sent'] = np.sqrt(daily['n_vote'] / (daily['n_vote'] + SENTIMENT_K))
  daily['z_sent_eff'] = daily['z_sent'] * daily['shrink_sent']

  weekly_raw = daily.groupby(['category', 'week_start'], as_index=False).agg(
    rev_raw=('rev_raw', 'sum'),
    votes_total_adj_raw=('votes_total_adj_raw', 'sum'),
    new_raw=('new_cnt', 'sum'),
    del_raw=('del_cnt', 'sum')
  )
  weights = compute_weights(weekly_raw)
  daily = daily.merge(weights, on=['category', 'week_start'], how='left')

  for col in ['weight_rev', 'weight_votesTotal', 'weight_netContent', 'weight_sentiment']:
    daily[col] = daily[col].fillna(0.0)

  daily['score_raw'] = (
    daily['weight_rev'] * daily['z_rev']
    + daily['weight_votesTotal'] * daily['z_votes_eff']
    + daily['weight_netContent'] * daily['z_net']
    + daily['weight_sentiment'] * daily['z_sent_eff']
    - DEL_RATE_PENALTY * daily['z_delRate']
  )
  daily = apply_score_drift_neutralization(daily)

  daily = daily.sort_values(['category', 'day']).copy()
  daily['index'] = np.nan
  for category, g in daily.groupby('category', sort=False):
    g = g.sort_values(['week_start', 'day']).copy()
    g_out = g[g['week_start'] >= output_start_week].copy()
    if g_out.empty:
      continue
    prev_close = INDEX_BASE
    for _, wg in g_out.groupby('week_start', sort=True):
      week_open = prev_close
      week_idx = week_open * np.exp(INDEX_K * wg['score'].to_numpy(dtype=float))
      prev_close = float(week_idx[-1])
      daily.loc[wg.index, 'index'] = week_idx

  daily_out = daily[daily['week_start'] >= output_start_week].copy()
  daily_out[[
    'day', 'category', 'week_start', 'offset',
    'score_raw', 'score_ref', 'score_centered', 'score', 'index'
  ]].to_csv(OUT_DIR / 'daily_score_index.csv', index=False)

  hourly_out = build_hourly_forecast_ticks(daily_out)
  hourly_out.to_csv(OUT_DIR / 'hourly_forecast_ticks.csv', index=False)

  ohlc_parts = []
  for category, g in daily_out.groupby('category', sort=False):
    g = g.sort_values('day').copy()
    w = g.groupby('week_start', as_index=False).agg(
      high=('index', 'max'),
      low=('index', 'min'),
      close=('index', 'last')
    )
    w = w.sort_values('week_start').copy()
    # K-line open should be previous close; first bar starts from INDEX_BASE.
    w['open'] = w['close'].shift(1).fillna(INDEX_BASE)
    w['high'] = np.maximum(w['high'], w['open'])
    w['low'] = np.minimum(w['low'], w['open'])
    w['category'] = category
    ohlc_parts.append(w[['category', 'week_start', 'open', 'high', 'low', 'close']])

  ohlc = pd.concat(ohlc_parts, ignore_index=True).sort_values(['category', 'week_start'])
  ohlc.to_csv(OUT_DIR / 'weekly_ohlc.csv', index=False)

  anchor_report = build_anchor_consistency_report(hourly_out, daily_out, ohlc)
  anchor_report.to_csv(OUT_DIR / 'anchor_consistency.csv', index=False)

  categories = ['OVERALL', 'TRANSLATION', 'SCP', 'TALE', 'GOI', 'WANDERERS']
  for category in categories:
    cdf = ohlc[ohlc['category'] == category].copy()
    if cdf.empty:
      continue
    draw_candles(
      cdf,
      title=f'v0.2.1 Preview K-Line - {category} (weekly OHLC from daily index)',
      out_path=OUT_DIR / f'kline_{category.lower()}.png'
    )

  print(
    'Window:',
    f'data_start={data_start_day.date()}',
    f'calc_start={calc_start_day.date()}',
    f'output_start_week={output_start_week.date()}',
    f'end={end_day.date()}'
  )
  print('ScoreDrift:',
    f'window_weeks={DRIFT_WINDOW_WEEKS}',
    f'min_hist={DRIFT_MIN_HISTORY_WEEKS}',
    f'beta_overall={DRIFT_BETA_OVERALL}',
    f'beta_translation={DRIFT_BETA_TRANSLATION}',
    f'beta_others={DRIFT_BETA_OTHERS}'
  )
  print('HourlyForecast:',
    f'ticks_per_day={HOURLY_TICKS_PER_DAY}',
    f'rows={len(hourly_out)}'
  )
  print('AnchorCheckMaxAbs:',
    ' '.join(
      f"{r['check']}={r['max_abs_diff']:.12f}"
      for _, r in anchor_report.iterrows()
    )
  )
  print(f'Wrote charts to: {OUT_DIR.resolve()}')


if __name__ == '__main__':
  main()
