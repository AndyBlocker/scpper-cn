import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authorInput,
  postPayload,
  threadPayload,
  type V1ForumPostRow,
  type V1ForumThreadRow,
} from '../src/backfill/forum-model.js';

describe('v1 forum backfill payload', () => {
  it('deleted 帖同时保留归一 user_id、姓名快照和 deleted 徽章', () => {
    const row: V1ForumPostRow = {
      id: 10,
      thread_id: 20,
      parent_post_id: null,
      title: null,
      text_html: '<p>历史内容</p>',
      created_by_name: '已注销的甲',
      created_by_wikidot_id: 30,
      created_by_type: 'deleted',
      created_at: '2020-01-01T00:00:00.000000Z',
      edited_at: null,
      is_deleted: false,
    };
    assert.deepEqual(authorInput(30, row.created_by_name, row.created_by_type), {
      wikidotId: 30,
      displayName: null,
    });
    assert.deepEqual(postPayload(row, 40), {
      id: 10,
      thread_id: 20,
      parent_post_id: null,
      author_user_id: 40,
      author_name: '已注销的甲',
      created_by_type: 'deleted',
      title: null,
      text_html: '<p>历史内容</p>',
      created_at: '2020-01-01T00:00:00.000000Z',
      edited_at: null,
      is_deleted: false,
    });
  });

  it('普通正 wid 作者走 user_id，不复制姓名快照', () => {
    assert.deepEqual(authorInput(30, 'Alice', 'user'), {
      wikidotId: 30,
      displayName: 'Alice',
    });
  });

  it('thread 的 v1 pageId 只标 inferred，未解析作者保留姓名', () => {
    const row: V1ForumThreadRow = {
      id: 1,
      category_id: 2,
      title: '主题',
      description: '不可丢的描述',
      created_by_name: '历史作者',
      created_by_wikidot_id: null,
      created_at: '2020-01-01T00:00:00.000000Z',
      post_count: 3,
      is_deleted: false,
      page_id: 4,
    };
    assert.deepEqual(threadPayload(row, null), {
      id: 1,
      category_id: 2,
      page_id: 4,
      page_id_source: 'inferred',
      title: '主题',
      description: '不可丢的描述',
      created_by_user_id: null,
      created_by_name: '历史作者',
      created_at: '2020-01-01T00:00:00.000000Z',
      post_count: 3,
      is_deleted: false,
    });
  });
});
