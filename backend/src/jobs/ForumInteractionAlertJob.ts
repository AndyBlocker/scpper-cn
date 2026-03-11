import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

const PAGE_DISCUSSION_CATEGORY_ID = 675245;
const MAX_EXCERPT_LENGTH = 180;

type AlertType = 'PAGE_REPLY' | 'DIRECT_REPLY' | 'MENTION';

type NewPostRow = {
  postId: number;
  threadId: number;
  categoryId: number;
  pageId: number | null;
  parentId: number | null;
  title: string | null;
  textHtml: string | null;
  createdByWikidotId: number | null;
  createdByName: string | null;
  parentCreatedByWikidotId: number | null;
};

type UserRow = { id: number; wikidotId: number | null };

type PageOwnerRow = { pageId: number; userId: number };

function decodeHtmlEntities(input: string): string {
  const entityMap: Array<[RegExp, string]> = [
    [/&nbsp;/gi, ' '],
    [/&amp;/gi, '&'],
    [/&lt;/gi, '<'],
    [/&gt;/gi, '>'],
    [/&quot;/gi, '"'],
    [/&#39;/gi, "'"],
  ];

  let output = input;
  for (let i = 0; i < 2; i += 1) {
    for (const [pattern, replacement] of entityMap) {
      output = output.replace(pattern, replacement);
    }
  }
  return output;
}

function htmlToExcerpt(html: string | null | undefined, maxLength = MAX_EXCERPT_LENGTH): string | null {
  if (!html || typeof html !== 'string') return null;
  const text = decodeHtmlEntities(
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );

  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function extractMentionWikidotIds(html: string | null | undefined): number[] {
  if (!html || typeof html !== 'string') return [];

  const ids = new Set<number>();
  const collect = (raw: string) => {
    const id = Number.parseInt(raw, 10);
    if (Number.isFinite(id) && id > 0) {
      ids.add(id);
    }
  };

  const userInfoPattern = /userInfo\((\d+)\)/gi;
  let userInfoMatch: RegExpExecArray | null = userInfoPattern.exec(html);
  while (userInfoMatch) {
    collect(userInfoMatch[1]);
    userInfoMatch = userInfoPattern.exec(html);
  }

  const userIdParamPattern = /(?:avatar\.php\?userid=|userkarma\.php\?u=|[?&](?:amp;)?userid=)(\d+)/gi;
  let userIdParamMatch: RegExpExecArray | null = userIdParamPattern.exec(html);
  while (userIdParamMatch) {
    collect(userIdParamMatch[1]);
    userIdParamMatch = userIdParamPattern.exec(html);
  }

  return Array.from(ids);
}

function assignAlertType(
  recipientMap: Map<number, { type: AlertType; priority: number }>,
  recipientUserId: number,
  type: AlertType,
  priority: number
): void {
  const existing = recipientMap.get(recipientUserId);
  if (!existing || priority > existing.priority) {
    recipientMap.set(recipientUserId, { type, priority });
  }
}

export class ForumInteractionAlertJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  async run(newPostIds: number[]): Promise<number> {
    const uniquePostIds = Array.from(new Set(
      (newPostIds || []).filter((id) => Number.isInteger(id) && id > 0)
    ));

    if (uniquePostIds.length === 0) {
      return 0;
    }

    const postIdArray = Prisma.sql`ARRAY[${Prisma.join(uniquePostIds.map((id) => Prisma.sql`${id}`))}]::int[]`;

    const posts = await this.prisma.$queryRaw<NewPostRow[]>(Prisma.sql`
      SELECT
        p.id AS "postId",
        p."threadId" AS "threadId",
        t."categoryId" AS "categoryId",
        t."pageId" AS "pageId",
        p."parentId" AS "parentId",
        p.title AS "title",
        p."textHtml" AS "textHtml",
        p."createdByWikidotId" AS "createdByWikidotId",
        p."createdByName" AS "createdByName",
        parent."createdByWikidotId" AS "parentCreatedByWikidotId"
      FROM "ForumPost" p
      JOIN "ForumThread" t ON t.id = p."threadId"
      LEFT JOIN "ForumPost" parent ON parent.id = p."parentId"
      WHERE p.id = ANY(${postIdArray})
        AND p."isDeleted" = false
        AND p."createdByType" = 'user'
        AND p."createdByWikidotId" IS NOT NULL
    `);

    if (posts.length === 0) {
      return 0;
    }

    const pageIds = Array.from(new Set(
      posts
        .filter((row) => row.categoryId === PAGE_DISCUSSION_CATEGORY_ID && row.pageId != null)
        .map((row) => Number(row.pageId))
    ));

    const pageOwners = pageIds.length > 0
      ? await this.loadPageOwners(pageIds)
      : [];

    const pageOwnerMap = new Map<number, Set<number>>();
    for (const owner of pageOwners) {
      const existing = pageOwnerMap.get(owner.pageId) || new Set<number>();
      existing.add(owner.userId);
      pageOwnerMap.set(owner.pageId, existing);
    }

    const mentionIdsByPost = new Map<number, number[]>();
    const wikidotIdSet = new Set<number>();

    for (const post of posts) {
      if (post.createdByWikidotId != null && post.createdByWikidotId > 0) {
        wikidotIdSet.add(Number(post.createdByWikidotId));
      }
      if (post.parentCreatedByWikidotId != null && post.parentCreatedByWikidotId > 0) {
        wikidotIdSet.add(Number(post.parentCreatedByWikidotId));
      }

      const mentionIds = extractMentionWikidotIds(post.textHtml);
      mentionIdsByPost.set(post.postId, mentionIds);
      for (const mentionId of mentionIds) {
        wikidotIdSet.add(mentionId);
      }
    }

    const wikidotIds = Array.from(wikidotIdSet);
    const userRows = wikidotIds.length > 0
      ? await this.prisma.$queryRaw<UserRow[]>(Prisma.sql`
          SELECT id, "wikidotId"
          FROM "User"
          WHERE "wikidotId" = ANY(ARRAY[${Prisma.join(wikidotIds.map((id) => Prisma.sql`${id}`))}]::int[])
        `)
      : [];

    const userIdByWikidotId = new Map<number, number>();
    const wikidotIdByUserId = new Map<number, number>();
    for (const row of userRows) {
      if (row.wikidotId != null && row.wikidotId > 0) {
        userIdByWikidotId.set(Number(row.wikidotId), Number(row.id));
        wikidotIdByUserId.set(Number(row.id), Number(row.wikidotId));
      }
    }

    const insertValues: Prisma.Sql[] = [];

    for (const post of posts) {
      const actorWikidotId = post.createdByWikidotId == null ? null : Number(post.createdByWikidotId);
      if (!actorWikidotId || actorWikidotId <= 0) {
        continue;
      }

      const actorUserId = userIdByWikidotId.get(actorWikidotId) ?? null;
      const recipients = new Map<number, { type: AlertType; priority: number }>();

      if (post.categoryId === PAGE_DISCUSSION_CATEGORY_ID && post.pageId != null) {
        const owners = pageOwnerMap.get(Number(post.pageId));
        if (owners && owners.size > 0) {
          for (const recipientUserId of owners) {
            if (actorUserId != null && recipientUserId === actorUserId) {
              continue;
            }
            if (actorUserId == null) {
              const recipientWikidotId = wikidotIdByUserId.get(recipientUserId);
              if (recipientWikidotId != null && recipientWikidotId === actorWikidotId) {
                continue;
              }
            }
            assignAlertType(recipients, recipientUserId, 'PAGE_REPLY', 1);
          }
        }
      }

      const mentionIds = mentionIdsByPost.get(post.postId) || [];
      for (const mentionWikidotId of mentionIds) {
        if (mentionWikidotId === actorWikidotId) {
          continue;
        }
        const recipientUserId = userIdByWikidotId.get(mentionWikidotId);
        if (!recipientUserId) {
          continue;
        }
        assignAlertType(recipients, recipientUserId, 'MENTION', 2);
      }

      if (post.parentCreatedByWikidotId != null && post.parentCreatedByWikidotId > 0) {
        const parentWikidotId = Number(post.parentCreatedByWikidotId);
        if (parentWikidotId !== actorWikidotId) {
          const recipientUserId = userIdByWikidotId.get(parentWikidotId);
          if (recipientUserId) {
            assignAlertType(recipients, recipientUserId, 'DIRECT_REPLY', 3);
          }
        }
      }

      if (recipients.size === 0) {
        continue;
      }

      const excerpt = htmlToExcerpt(post.textHtml);
      for (const [recipientUserId, info] of recipients.entries()) {
        insertValues.push(Prisma.sql`(
          ${recipientUserId},
          ${actorUserId},
          ${actorWikidotId},
          ${post.createdByName ?? null},
          CAST(${info.type} AS "ForumInteractionAlertType"),
          ${post.postId},
          ${post.parentId ?? null},
          ${post.threadId},
          ${post.pageId ?? null},
          ${post.title ?? null},
          ${excerpt}
        )`);
      }
    }

    if (insertValues.length === 0) {
      return 0;
    }

    const inserted = await this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
      INSERT INTO "ForumInteractionAlert" (
        "recipientUserId",
        "actorUserId",
        "actorWikidotId",
        "actorName",
        "type",
        "postId",
        "parentPostId",
        "threadId",
        "pageId",
        "postTitle",
        "postExcerpt"
      )
      VALUES ${Prisma.join(insertValues, ', ')}
      ON CONFLICT ("recipientUserId", "type", "postId") DO NOTHING
      RETURNING id
    `);

    const createdCount = inserted.length;
    if (createdCount > 0) {
      Logger.info(`[forum-alerts] Created ${createdCount} forum interaction alerts from ${posts.length} new posts.`);
    }

    return createdCount;
  }

  private async loadPageOwners(pageIds: number[]): Promise<PageOwnerRow[]> {
    if (!pageIds || pageIds.length === 0) {
      return [];
    }

    const pageIdArray = Prisma.sql`ARRAY[${Prisma.join(pageIds.map((id) => Prisma.sql`${id}`))}]::int[]`;

    const rows = await this.prisma.$queryRaw<PageOwnerRow[]>(Prisma.sql`
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      )
      SELECT DISTINCT pv."pageId" AS "pageId", a."userId" AS "userId"
      FROM effective_attributions a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = false
        AND pv."pageId" = ANY(${pageIdArray})
        AND a."userId" IS NOT NULL

      UNION

      SELECT DISTINCT pv."pageId" AS "pageId", r."userId" AS "userId"
      FROM "Revision" r
      JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = false
        AND pv."pageId" = ANY(${pageIdArray})
        AND r."userId" IS NOT NULL
        AND r.type = 'PAGE_CREATED'
    `);

    return rows;
  }
}
