import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import rateLimit from 'express-rate-limit';

import { createCache } from '../utils/cache.js';
import { getReadPoolSync } from '../utils/dbPool.js';
import { parsePositiveInt } from '../utils/helpers.js';

import { renderSvgBadge } from '../utils/embed/svgBadge.js';
import { renderSparkline } from '../utils/embed/sparkline.js';
import { resolveTheme } from '../utils/embed/theme.js';
import { sendEmbedHtml } from '../utils/embed/htmlWrapper.js';
import { sanitizeInlineCss } from '../utils/embed/inlineCss.js';
import { loadPageBadgeData, loadPageVotingSeries } from '../utils/embed/pageData.js';
import {
  loadUserBasicByWikidotId,
  loadUserCardStats,
  loadUserVotingSeries,
  loadUserActivityHeatmap
} from '../utils/embed/userData.js';
import {
  USER_CARD_BASE_CSS,
  renderUserCardBody,
  type UserCardRenderOptions
} from '../utils/embed/templates/userCard.js';
import {
  USER_HISTORY_BASE_CSS,
  renderUserHistoryBody,
  type UserHistoryRenderOptions
} from '../utils/embed/templates/userHistory.js';

const BADGE_CACHE_SECONDS = 300;
const USER_CARD_CACHE_SECONDS = 300;
const USER_HISTORY_CACHE_SECONDS = 600;

const VALID_BADGE_METRICS = new Set(['rating', 'wilson', 'controversy', 'votes', 'trend']);
const VALID_BADGE_STYLES = new Set(['flat', 'plastic', 'mono']);

function parseFlag(value: unknown, def: boolean): boolean {
  if (value === undefined || value === null) return def;
  const str = String(value).toLowerCase();
  if (str === '1' || str === 'true' || str === 'yes' || str === 'on') return true;
  if (str === '0' || str === 'false' || str === 'no' || str === 'off') return false;
  return def;
}

function parseRange(raw: unknown): '90d' | '1y' | 'all' {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === '1y' || s === '365d' || s === '12m') return '1y';
  if (s === 'all') return 'all';
  return '90d';
}

/** 仅接受 3/6/8 位 hex，不带 #。其他输入（含 "currentColor" 之类的关键字）一律视为未传。 */
function normalizeAccentParam(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(trimmed) || /^[0-9a-f]{6}$/.test(trimmed) || /^[0-9a-f]{8}$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

/** label 长度/字符收紧，最多 32 个可见 ASCII+中文，用来防御 cache key 轰炸和 SVG 过宽。 */
function normalizeLabelParam(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.length > 32) return trimmed.slice(0, 32);
  return trimmed;
}

/** 渲染一个走 sendEmbedHtml 包装的极简 404 页，保留 frame-ancestors / CSP / 缓存控制。 */
function sendEmbedNotFound(
  res: import('express').Response,
  themeOpts: import('../utils/embed/theme.js').ResolvedTheme,
  message: string
) {
  const body = `<div class="e-empty-card">${message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</div>`;
  const baseCss = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: transparent; }
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif; color: var(--e-text-muted); font-size: 13px; }
    .e-empty-card { padding: 16px 20px; border: 1px dashed var(--e-border); border-radius: 12px; background: var(--e-surface); text-align: center; }
  `;
  sendEmbedHtml(res, {
    title: 'SCPPER-CN',
    baseCss,
    bodyHtml: body,
    theme: themeOpts,
    extraImgSrc: "'self' data:",
    cacheSeconds: 60,
    statusCode: 404
  });
}

function trimSeriesToLastDays(values: number[], days: number): number[] {
  if (values.length <= days) return values.slice();
  return values.slice(values.length - days);
}

function metricColor(metric: string, themeMono: boolean): string | undefined {
  if (themeMono) return undefined;
  switch (metric) {
    case 'wilson':
      return '#16a34a';
    case 'controversy':
      return '#d97706';
    case 'votes':
      return '#6f4ef2';
    case 'trend':
      return '#0ea5e9';
    default:
      return '#4c1';
  }
}

export function embedRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  const cache = createCache(redis);
  const readPool = getReadPoolSync(pool);

  // 整个 /embed 下统一做一层保守限速，防止单 IP 刷爆缓存层
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' }
  });
  router.use(limiter);

  router.param('wikidotId', (req, res, next, value) => {
    if (parsePositiveInt(value) === null) {
      return res.status(400).json({ error: 'invalid_wikidotId' });
    }
    return next();
  });

  // ──────────────────────────────────────
  // 1) SVG badge: GET /embed/badge/page/:wikidotId.svg
  // ──────────────────────────────────────
  router.get('/badge/page/:wikidotId\\.svg', async (req, res, next) => {
    try {
      const wikidotId = Number((req.params as Record<string, string>).wikidotId);
      const rawMetric = typeof req.query.metric === 'string' ? req.query.metric.toLowerCase() : 'rating';
      const rawStyle = typeof req.query.style === 'string' ? req.query.style.toLowerCase() : 'flat';
      if (!VALID_BADGE_METRICS.has(rawMetric)) {
        return res.status(400).json({ error: 'invalid_metric', allowed: Array.from(VALID_BADGE_METRICS) });
      }
      if (!VALID_BADGE_STYLES.has(rawStyle)) {
        return res.status(400).json({ error: 'invalid_style', allowed: Array.from(VALID_BADGE_STYLES) });
      }
      const metric = rawMetric as 'rating' | 'wilson' | 'controversy' | 'votes' | 'trend';
      const style = rawStyle as 'flat' | 'plastic' | 'mono';
      const themeMono = style === 'mono' || String(req.query.theme || '').toLowerCase() === 'mono';
      const accentHex = normalizeAccentParam(req.query.accent);
      // trend 模式下 accent/label 不参与渲染，就不要让它进 cache key，避免
      // `?metric=trend&accent=1/2/3...` 刷穿 JSONB 读取。
      const labelOverride = metric === 'trend' ? '' : normalizeLabelParam(req.query.label);
      const accentForKey = metric === 'trend' ? '' : accentHex;

      const cacheKey = `embed:badge:page:${wikidotId}:${metric}:${style}:${themeMono ? 'm' : 'c'}:${accentForKey}:${labelOverride}`;

      const svg = await cache.remember(cacheKey, BADGE_CACHE_SECONDS, async () => {
        if (metric === 'trend') {
          const series = await loadPageVotingSeries(readPool, wikidotId);
          if (!series) {
            return renderSvgBadge({
              label: 'scpper',
              value: 'no data',
              style: style === 'mono' ? 'flat' : style,
              themeMono,
              color: '#9ca3af'
            });
          }
          // 按用户拍板：sparkline 默认 90 天
          const windowDays = 90;
          const dailyUp = series.dailyUpvotes.slice(-windowDays);
          const dailyDown = series.dailyDownvotes.slice(-windowDays);
          const n = Math.max(dailyUp.length, dailyDown.length);
          const net: number[] = [];
          let running = 0;
          // 用完整缓存末尾的 cumulative 作为初始值
          const prefixN = Math.max(0, series.upvotes.length - n);
          if (prefixN > 0) {
            running = (series.upvotes[prefixN - 1] ?? 0) - (series.downvotes[prefixN - 1] ?? 0);
          }
          for (let i = 0; i < n; i += 1) {
            running += (dailyUp[i] ?? 0) - (dailyDown[i] ?? 0);
            net.push(running);
          }
          const stroke = themeMono ? 'currentColor' : (metricColor('trend', false) as string);
          return renderSparkline({
            values: net,
            width: 140,
            height: 28,
            stroke,
            fill: themeMono ? 'none' : 'color-mix(in srgb, #0ea5e9 20%, transparent)',
            showZeroAxis: true
          });
        }

        const page = await loadPageBadgeData(readPool, wikidotId);
        if (!page) {
          return renderSvgBadge({
            label: labelOverride || 'scpper',
            value: 'not found',
            style: style === 'mono' ? 'flat' : style,
            themeMono,
            color: '#9ca3af'
          });
        }

        let label = labelOverride || 'rating';
        let value = String(page.rating);
        switch (metric) {
          case 'wilson':
            label = labelOverride || 'wilson 95%';
            value = page.wilson95 != null ? page.wilson95.toFixed(3) : '—';
            break;
          case 'controversy':
            label = labelOverride || 'controversy';
            value = page.controversy != null ? page.controversy.toFixed(3) : '—';
            break;
          case 'votes':
            label = labelOverride || 'votes';
            value = String(page.voteCount);
            break;
          case 'rating':
          default:
            label = labelOverride || 'rating';
            value = (page.rating >= 0 ? '+' : '') + String(page.rating);
            break;
        }

        const colorKey = metric === 'rating' ? (page.rating >= 0 ? 'rating_pos' : 'rating_neg') : metric;
        let color: string | undefined;
        if (!themeMono) {
          if (colorKey === 'rating_pos') color = '#4c1';
          else if (colorKey === 'rating_neg') color = '#e05d44';
          else color = metricColor(metric, false);
          if (accentHex) color = undefined; // 若用户传 accent，优先走 accent
        }
        return renderSvgBadge({
          label,
          value,
          style: style === 'mono' ? 'flat' : style,
          themeMono,
          color: accentHex ? `#${accentHex}` : color,
          title: page.title || undefined
        });
      });

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', `public, max-age=${BADGE_CACHE_SECONDS}, s-maxage=${BADGE_CACHE_SECONDS * 3}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(svg);
    } catch (error) {
      next(error);
    }
  });

  // ──────────────────────────────────────
  // 2) User card iframe: GET /embed/user-card/:wikidotId
  // ──────────────────────────────────────
  router.get('/user-card/:wikidotId', async (req, res, next) => {
    try {
      const wikidotId = Number((req.params as Record<string, string>).wikidotId);
      const themeOpts = resolveTheme(req.query.theme, req.query.accent);
      const breakdown = (String(req.query.breakdown || 'list').toLowerCase() === 'radar')
        ? 'radar'
        : 'list';
      const hideActivity = parseFlag(req.query.hideActivity, false);
      const categoriesParam = typeof req.query.showCategories === 'string' ? req.query.showCategories : '';
      const showCategories = categoriesParam
        ? categoriesParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : [];

      const userCss = typeof req.query.css === 'string' ? req.query.css : '';
      const sanitizedCss = sanitizeInlineCss(userCss);

      const dataCacheKey = `embed:user-card-data:${wikidotId}`;
      const data = await cache.remember(dataCacheKey, USER_CARD_CACHE_SECONDS, async () => {
        const user = await loadUserBasicByWikidotId(readPool, wikidotId);
        if (!user) return null;
        const stats = await loadUserCardStats(readPool, wikidotId);
        if (!stats) return null;
        return { user, stats };
      });

      if (!data) {
        return sendEmbedNotFound(res, themeOpts, '用户不存在或无统计数据');
      }

      const renderOpts: UserCardRenderOptions = {
        breakdown,
        hideActivity,
        showCategories
      };

      const bodyHtml = renderUserCardBody(data.user, data.stats, renderOpts);
      sendEmbedHtml(res, {
        title: `${data.user.displayName || 'User'} · SCPPER-CN`,
        baseCss: USER_CARD_BASE_CSS,
        userCss: sanitizedCss,
        bodyHtml,
        theme: themeOpts,
        // user-card 不再放开外部 https 图片：作者自定义 CSS 只允许 same-origin 和 data:image，
        // 防止 url() 被当作访客追踪像素。头像走 /api/avatar（同源）仍能工作。
        extraImgSrc: "'self' data:",
        cacheSeconds: USER_CARD_CACHE_SECONDS
      });
    } catch (error) {
      next(error);
    }
  });

  // ──────────────────────────────────────
  // 3) User history iframe: GET /embed/user-history/:wikidotId
  // ──────────────────────────────────────
  router.get('/user-history/:wikidotId', async (req, res, next) => {
    try {
      const wikidotId = Number((req.params as Record<string, string>).wikidotId);
      const themeOpts = resolveTheme(req.query.theme, req.query.accent);
      const range = parseRange(req.query.range);
      const showTrend = parseFlag(req.query.showTrend, true);
      const showHeatmap = parseFlag(req.query.showHeatmap, true);

      const userCss = typeof req.query.css === 'string' ? req.query.css : '';
      const sanitizedCss = sanitizeInlineCss(userCss);

      const dataCacheKey = `embed:user-history-data:${wikidotId}:${range}:${showTrend ? 1 : 0}:${showHeatmap ? 1 : 0}`;
      const data = await cache.remember(dataCacheKey, USER_HISTORY_CACHE_SECONDS, async () => {
        const user = await loadUserBasicByWikidotId(readPool, wikidotId);
        if (!user) return null;
        const series = showTrend ? await loadUserVotingSeries(readPool, wikidotId) : null;
        const heatmap = showHeatmap
          ? await loadUserActivityHeatmap(readPool, user.id, 366)
          : [];
        return { user, series, heatmap };
      });

      if (!data) {
        return sendEmbedNotFound(res, themeOpts, '用户不存在');
      }

      const renderOpts: UserHistoryRenderOptions = {
        range,
        showTrend,
        showHeatmap
      };

      const bodyHtml = renderUserHistoryBody(data.user, data.series, data.heatmap, renderOpts);
      sendEmbedHtml(res, {
        title: `${data.user.displayName || 'User'} · 历史 · SCPPER-CN`,
        baseCss: USER_HISTORY_BASE_CSS,
        userCss: sanitizedCss,
        bodyHtml,
        theme: themeOpts,
        extraImgSrc: "'self' data:",
        cacheSeconds: USER_HISTORY_CACHE_SECONDS
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
