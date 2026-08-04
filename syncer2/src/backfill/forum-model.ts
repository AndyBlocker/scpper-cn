export interface V1ForumThreadRow {
  id: number;
  category_id: number;
  title: string;
  description: string | null;
  created_by_name: string;
  created_by_wikidot_id: number | null;
  created_at: string;
  post_count: number;
  is_deleted: boolean;
  page_id: number | null;
}

export interface V1ForumPostRow {
  id: number;
  thread_id: number;
  parent_post_id: number | null;
  title: string | null;
  text_html: string;
  created_by_name: string;
  created_by_wikidot_id: number;
  created_by_type: string;
  created_at: string;
  edited_at: string | null;
  is_deleted: boolean;
}

export interface ForumAuthorInput {
  wikidotId: number;
  displayName: string | null;
}

export function authorInput(
  wikidotId: number | null,
  displayName: string | null,
  createdByType: string | null,
): ForumAuthorInput | null {
  if (wikidotId === null || !Number.isSafeInteger(wikidotId) || wikidotId <= 0) return null;
  return {
    wikidotId,
    // 历史 deleted 占位名不能覆盖 ingest.user 当前显示名；姓名另存帖子快照。
    displayName: createdByType === 'deleted' ? null : displayName,
  };
}

export function threadPayload(
  row: V1ForumThreadRow,
  authorUserId: number | null,
  targetPageId: number | null = row.page_id,
): Record<string, unknown> {
  return {
    id: row.id,
    category_id: row.category_id,
    page_id: targetPageId,
    page_id_source: targetPageId === null ? null : 'inferred',
    title: row.title,
    description: row.description,
    created_by_user_id: authorUserId,
    created_by_name: authorUserId === null ? row.created_by_name : null,
    created_at: row.created_at,
    post_count: row.post_count,
    is_deleted: row.is_deleted,
  };
}

export function postPayload(
  row: V1ForumPostRow,
  authorUserId: number,
): Record<string, unknown> {
  return {
    id: row.id,
    thread_id: row.thread_id,
    parent_post_id: row.parent_post_id,
    author_user_id: authorUserId,
    // deleted 即使有稳定 wid/user_id 也保留署名快照，不能合成或抹掉。
    author_name: row.created_by_type === 'deleted' ? row.created_by_name : null,
    created_by_type: row.created_by_type,
    title: row.title,
    text_html: row.text_html,
    created_at: row.created_at,
    edited_at: row.edited_at,
    is_deleted: row.is_deleted,
  };
}
