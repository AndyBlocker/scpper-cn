import { PrismaClient } from '@prisma/client';

export type ValidationRow = {
  userId: number;
  wikidotId: number | null;
  displayName: string | null;
  // expected vs actual counts/ratings per category
  scp_count_expected: number; scp_count_actual: number;
  scp_rating_expected: number; scp_rating_actual: number;
  story_count_expected: number; story_count_actual: number;
  story_rating_expected: number; story_rating_actual: number;
  goi_count_expected: number; goi_count_actual: number;
  goi_rating_expected: number; goi_rating_actual: number;
  translation_count_expected: number; translation_count_actual: number;
  translation_rating_expected: number; translation_rating_actual: number;
  wanderers_count_expected: number; wanderers_count_actual: number;
  wanderers_rating_expected: number; wanderers_rating_actual: number;
  art_count_expected: number; art_count_actual: number;
  art_rating_expected: number; art_rating_actual: number;
  overall_pages_expected: number; overall_pages_actual: number;
  overall_rating_expected: number; overall_rating_actual: number;
};

/**
 * Validate UserStats against recomputed aggregation on current PageVersion + tags.
 * Rules must mirror UserRatingJob:
 * - overall: pages where user has any association (AUTHOR | SUBMITTER | TRANSLATOR)
 * - scp/story/goi/wanderers/art: AUTHOR|SUBMITTER and tags include 原创 + <cat>
 * - translation: any association AND tags not including 原创
 */
export async function validateUserStats(prisma: PrismaClient, limit: number = 200): Promise<ValidationRow[]> {
  const rows = await prisma.$queryRaw<ValidationRow[]>`
    WITH user_page_roles AS (
      SELECT a."userId", pv."pageId",
             MAX(CASE WHEN a.type IN ('AUTHOR','SUBMITTER') THEN 1 ELSE 0 END) AS has_author,
             MAX(CASE WHEN a.type IN ('TRANSLATOR') THEN 1 ELSE 0 END) AS has_translator
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      WHERE a."userId" IS NOT NULL AND pv."validTo" IS NULL AND pv."isDeleted" = false
      GROUP BY a."userId", pv."pageId"
    ),
    current_versions AS (
      SELECT pv."pageId", pv.rating, pv.tags, pv.category
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL AND pv."isDeleted" = false AND pv.rating IS NOT NULL
    ),
    agg AS (
      SELECT 
        upr."userId",
        -- overall
        COUNT(CASE WHEN (upr.has_author = 1 OR upr.has_translator = 1) THEN 1 END) AS overall_pages_expected,
        SUM(CASE WHEN (upr.has_author = 1 OR upr.has_translator = 1) THEN cv.rating::float ELSE 0 END) AS overall_rating_expected,

        -- scp
        COUNT(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','scp'] THEN 1 END) AS scp_count_expected,
        SUM(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','scp'] THEN cv.rating::float ELSE 0 END) AS scp_rating_expected,

        -- story
        COUNT(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','故事'] THEN 1 END) AS story_count_expected,
        SUM(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','故事'] THEN cv.rating::float ELSE 0 END) AS story_rating_expected,

        -- goi
        COUNT(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','goi格式'] THEN 1 END) AS goi_count_expected,
        SUM(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','goi格式'] THEN cv.rating::float ELSE 0 END) AS goi_rating_expected,

        -- wanderers
        COUNT(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','wanderers'] THEN 1 END) AS wanderers_count_expected,
        SUM(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','wanderers'] THEN cv.rating::float ELSE 0 END) AS wanderers_rating_expected,

        -- art
        COUNT(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','艺术作品'] THEN 1 END) AS art_count_expected,
        SUM(CASE WHEN upr.has_author = 1 AND cv.tags @> ARRAY['原创','艺术作品'] THEN cv.rating::float ELSE 0 END) AS art_rating_expected,

        -- translation (tag-based; any association; tags NOT containing 原创/作者/掩盖页/段落/补充材料; exclude categories)
        COUNT(CASE WHEN (upr.has_author = 1 OR upr.has_translator = 1)
                     AND NOT (cv.tags @> ARRAY['原创'])
                     AND NOT (cv.tags @> ARRAY['作者'])
                     AND NOT (cv.tags @> ARRAY['掩盖页'])
                     AND NOT (cv.tags @> ARRAY['段落'])
                     AND NOT (cv.tags @> ARRAY['补充材料'])
                     AND NOT (cv.category IN ('log-of-anomalous-items-cn','short-stories'))
                   THEN 1 END) AS translation_count_expected,
        SUM(CASE WHEN (upr.has_author = 1 OR upr.has_translator = 1)
                     AND NOT (cv.tags @> ARRAY['原创'])
                     AND NOT (cv.tags @> ARRAY['作者'])
                     AND NOT (cv.tags @> ARRAY['掩盖页'])
                     AND NOT (cv.tags @> ARRAY['段落'])
                     AND NOT (cv.tags @> ARRAY['补充材料'])
                     AND NOT (cv.category IN ('log-of-anomalous-items-cn','short-stories'))
                 THEN cv.rating::float ELSE 0 END) AS translation_rating_expected
      FROM user_page_roles upr
      JOIN current_versions cv ON cv."pageId" = upr."pageId"
      GROUP BY upr."userId"
    ),
    joined AS (
      SELECT 
        u.id AS "userId",
        u."wikidotId",
        u."displayName",
        -- expected
        a.overall_pages_expected,
        a.overall_rating_expected,
        a.scp_count_expected, a.scp_rating_expected,
        a.story_count_expected, a.story_rating_expected,
        a.goi_count_expected, a.goi_rating_expected,
        a.wanderers_count_expected, a.wanderers_rating_expected,
        a.art_count_expected, a.art_rating_expected,
        a.translation_count_expected, a.translation_rating_expected,
        -- actual (from UserStats)
        COALESCE(us."pageCount",0) AS overall_pages_actual,
        COALESCE(us."overallRating",0)::float AS overall_rating_actual,
        COALESCE(us."scpPageCount",0) AS scp_count_actual,
        COALESCE(us."scpRating",0)::float AS scp_rating_actual,
        COALESCE(us."storyPageCount",0) AS story_count_actual,
        COALESCE(us."storyRating",0)::float AS story_rating_actual,
        COALESCE(us."goiPageCount",0) AS goi_count_actual,
        COALESCE(us."goiRating",0)::float AS goi_rating_actual,
        COALESCE(us."wanderersPageCount",0) AS wanderers_count_actual,
        COALESCE(us."wanderersRating",0)::float AS wanderers_rating_actual,
        COALESCE(us."artPageCount",0) AS art_count_actual,
        COALESCE(us."artRating",0)::float AS art_rating_actual,
        COALESCE(us."translationPageCount",0) AS translation_count_actual,
        COALESCE(us."translationRating",0)::float AS translation_rating_actual
      FROM "User" u
      LEFT JOIN agg a ON a."userId" = u.id
      LEFT JOIN "UserStats" us ON us."userId" = u.id
    )
    SELECT * FROM joined
    WHERE (
      scp_count_expected IS DISTINCT FROM scp_count_actual OR scp_rating_expected IS DISTINCT FROM scp_rating_actual OR
      story_count_expected IS DISTINCT FROM story_count_actual OR story_rating_expected IS DISTINCT FROM story_rating_actual OR
      goi_count_expected IS DISTINCT FROM goi_count_actual OR goi_rating_expected IS DISTINCT FROM goi_rating_actual OR
      translation_count_expected IS DISTINCT FROM translation_count_actual OR translation_rating_expected IS DISTINCT FROM translation_rating_actual OR
      wanderers_count_expected IS DISTINCT FROM wanderers_count_actual OR wanderers_rating_expected IS DISTINCT FROM wanderers_rating_actual OR
      art_count_expected IS DISTINCT FROM art_count_actual OR art_rating_expected IS DISTINCT FROM art_rating_actual OR
      overall_pages_expected IS DISTINCT FROM overall_pages_actual OR overall_rating_expected IS DISTINCT FROM overall_rating_actual
    )
    ORDER BY "userId" ASC
    LIMIT ${limit}
  `;
  return rows;
}


