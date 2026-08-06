import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import type { RestrictedListPageRecord } from '../collect/restrictedListPages.js';
import { query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { sanitizePgText, toPgJson } from '../store/pgText.js';

export interface RestrictedPageApplyResult {
  pageId: number;
  wikidotId: number;
  ownerActorId: number | null;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
  attribution: Record<string, unknown> | null;
}

/** ListPages 的页面级权威观测原子落库；rating/revision 只写 claim，不越权改聚合列。 */
export async function applyRestrictedListPage(
  pool: Pool,
  args: {
    row: RestrictedListPageRecord;
    pageId: number;
    wikidotId: number;
    observedAt: string;
    runId: number | null;
  },
): Promise<RestrictedPageApplyResult> {
  return withTransaction(pool, `restricted-page:${args.pageId}`, async (db) => {
    let ownerActorId: number | null = null;
    if (args.row.createdById !== null) {
      const owner = await query<{ actor_id: number }>(
        db,
        'restricted:ensure_creator',
        `SELECT ingest.ensure_user(
           p_kind         => 'wikidot',
           p_wikidot_id   => $1,
           p_display_name => $2,
           p_unix_name    => $3
         ) AS actor_id`,
        [args.row.createdById, args.row.createdBy, args.row.createdByUnix],
      );
      ownerActorId = Number(owner.rows[0]!.actor_id);
    }

    const metadataAttrs = {
      slug: args.row.fullname,
      title: args.row.title,
      tags: args.row.tags,
      hidden_tags: args.row.hiddenTags,
      category: args.row.category,
      parent:
        args.row.parentFullname === null
          ? null
          : { page_id: null, slug: args.row.parentFullname },
      first_published_at: args.row.createdAt,
      comment_count: args.row.comments,
      claimed_rating: args.row.rating,
      claimed_vote_count: args.row.ratingVotes,
    };
    const metadata = await query<{ result: Record<string, unknown> }>(
      db,
      'restricted:apply_page_meta',
      `SELECT ingest.apply_page_meta(
         p_page       => $1::int,
         p_attrs      => $2::jsonb,
         p_observed   => $3::timestamptz,
         p_source     => 'wikidot_listpages',
         p_run        => $4::bigint,
         p_wikidot_id => $5::int
       ) AS result`,
      [
        args.pageId,
        toPgJson(metadataAttrs, `restricted.page_meta:${args.pageId}`),
        toPgTimestamptz(args.observedAt),
        args.runId,
        args.wikidotId,
      ],
    );

    // ListPages 完整轮 + 登录态真实 identity 是正向存在证据。匿名无分类链路曾把
    // 这些页误判 deleted；必须通过生命事件恢复，不能直接 UPDATE status。
    await query(
      db,
      'restricted:restore_page_life',
      `SELECT ingest.apply_page_life(
         p_page         => $1::int,
         p_kind         => 'restored',
         p_occurred     => $2::timestamptz,
         p_precision    => 'inferred',
         p_observed     => $2::timestamptz,
         p_source       => 'wikidot_listpages',
         p_run          => $3::bigint,
         p_wikidot_id   => $4::int
       )`,
      [args.pageId, toPgTimestamptz(args.observedAt), args.runId, args.wikidotId],
    );

    const html = sanitizePgText(args.row.contentHtml, {
      context: `restricted.content_html:${args.pageId}`,
    }).value;
    const text = sanitizePgText(args.row.textContent, {
      context: `restricted.text_content:${args.pageId}`,
    }).value;
    const sha = createHash('sha256').update(html, 'utf8').digest();
    const content = await query<{ result: Record<string, unknown> }>(
      db,
      'restricted:apply_rendered_content',
      `SELECT ingest.apply_listpages_rendered_content(
         $1::int, $2::bytea, $3::text, $4::text,
         $5::timestamptz, $6::bigint, $7::int
       ) AS result`,
      [
        args.pageId,
        sha,
        html,
        text,
        toPgTimestamptz(args.observedAt),
        args.runId,
        args.wikidotId,
      ],
    );

    let attribution: Record<string, unknown> | null = null;
    if (ownerActorId !== null) {
      const applied = await query<{ result: Record<string, unknown> }>(
        db,
        'restricted:apply_submitter',
        `SELECT ingest.apply_attribution_snapshot(
           p_page        => $1::int,
           p_entries     => $2::jsonb,
           p_is_complete => false,
           p_observed    => $3::timestamptz,
           p_source      => 'wikidot_listpages',
           p_run         => $4::bigint,
           p_wikidot_id  => $5::int
         ) AS result`,
        [
          args.pageId,
          toPgJson(
            [{ actor_id: ownerActorId, role: 'SUBMITTER', ord: 0, at_date: args.row.createdAt.slice(0, 10) }],
            `restricted.submitter:${args.pageId}`,
          ),
          toPgTimestamptz(args.observedAt),
          args.runId,
          args.wikidotId,
        ],
      );
      attribution = applied.rows[0]?.result ?? {};
    }

    await query(
      db,
      'restricted:revision_claim',
      `SELECT meta.record_page_scan(
         $1::bigint, $2::int, 'revisions', 'partial',
         $3::int, NULL, NULL, NULL, NULL, $4::bytea,
         'listpages_claim_only:等待 revisions_full 完整抓取'
       )`,
      [
        args.runId,
        args.pageId,
        args.row.revisions,
        createHash('sha256')
          .update(`${args.row.fullname}\n${args.row.revisions}`, 'utf8')
          .digest(),
      ],
    );

    return {
      pageId: args.pageId,
      wikidotId: args.wikidotId,
      ownerActorId,
      metadata: metadata.rows[0]?.result ?? {},
      content: content.rows[0]?.result ?? {},
      attribution,
    };
  });
}
