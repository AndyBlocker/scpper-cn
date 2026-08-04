import { createHash } from 'node:crypto';

import { extractTextFromWikidotSource } from '../content/extractText.js';

export const S2_PROGRESS_DOMAIN = 's2_content_revision';

export type TextContentBasis =
  | 'wikidot_html'
  | 'v1_crom'
  | 'v1_source_fallback';

export interface V1ContentCandidate {
  canonical_page_id: number;
  v1_page_version_id: number;
  source: string;
  text_content: string | null;
  wants_html: boolean;
}

export interface HtmlOverride {
  pageId: number;
  source: string;
  textContent: string;
}

export interface ContentBlobPlan {
  sha256Hex: string;
  source: string;
  textContent: string;
  basis: TextContentBasis;
  canonicalPageId: number;
  v1PageVersionId: number | null;
}

export function sha256Hex(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/**
 * 同一 source sha 只能对应一行 append-only content_blob。
 *
 * canonical SQL 已按 html > v1 CROM > 源码兜底选代表行；这里负责把代表行变成最终
 * blob，并校验 HTML 的源码仍与 v1 快照一致。远端源码已变化时由调用方另建 override
 * blob，旧 v1 source 仍按源码兜底保存，绝不把新 HTML 正文绑到旧 sha 上。
 */
export function buildContentBlobPlan(
  row: V1ContentCandidate,
  htmlOverride: HtmlOverride | undefined,
): ContentBlobPlan {
  const sourceSha = sha256Hex(row.source);
  if (
    row.wants_html &&
    htmlOverride !== undefined &&
    sha256Hex(htmlOverride.source) === sourceSha
  ) {
    return {
      sha256Hex: sourceSha,
      source: row.source,
      textContent: htmlOverride.textContent,
      basis: 'wikidot_html',
      canonicalPageId: row.canonical_page_id,
      v1PageVersionId: row.v1_page_version_id,
    };
  }

  if (row.text_content !== null && row.text_content !== '') {
    return {
      sha256Hex: sourceSha,
      source: row.source,
      textContent: row.text_content,
      basis: 'v1_crom',
      canonicalPageId: row.canonical_page_id,
      v1PageVersionId: row.v1_page_version_id,
    };
  }

  return {
    sha256Hex: sourceSha,
    source: row.source,
    textContent: extractTextFromWikidotSource(row.source),
    basis: 'v1_source_fallback',
    canonicalPageId: row.canonical_page_id,
    v1PageVersionId: row.v1_page_version_id,
  };
}

/** 新旧远端源码不同：新源码/HTML 作为无 rev_no 的当前观测另存，不污染 v1 快照。 */
export function buildOverrideBlobPlan(override: HtmlOverride): ContentBlobPlan {
  return {
    sha256Hex: sha256Hex(override.source),
    source: override.source,
    textContent: override.textContent,
    basis: 'wikidot_html',
    canonicalPageId: override.pageId,
    v1PageVersionId: null,
  };
}

export function basisRank(basis: TextContentBasis): number {
  switch (basis) {
    case 'wikidot_html':
      return 3;
    case 'v1_crom':
      return 2;
    case 'v1_source_fallback':
      return 1;
  }
}
