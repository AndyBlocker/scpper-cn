import { PrismaClient } from '@prisma/client';
import { Logger } from '../utils/Logger.js';

export type LinkType = 'TRIPLE' | 'SHORT' | 'DIRECT';

export interface PageReferenceCandidate {
  linkType: LinkType;
  targetPath: string;
  targetFragment?: string | null;
  displayTexts: string[];
  rawTarget?: string;
  rawText?: string;
  occurrence: number;
}

interface CandidateAccumulator {
  key: string;
  linkType: LinkType;
  targetPath: string;
  targetFragment?: string | null;
  rawTarget?: string;
  rawText?: string;
  occurrence: number;
  displays: Set<string>;
}

interface NormalizedTarget {
  path: string;
  fragment?: string | null;
  rawTarget: string;
}

const SITE_DOMAIN_REGEX = /^(?:https?:\/\/)?(?:www\.)?scp-wiki-cn\.wikidot\.com/i;
const HTTP_PREFIX_REGEX = /^https?:\/\//i;
const PROTOCOL_RELATIVE_REGEX = /^\/\//;
const LOCAL_FILES_REGEX = /^local--files\//i;
const INVALID_PREFIXES = /^(?:javascript:|mailto:)/i;
const MAX_DISPLAY_VARIANTS = 10;

function slugifySegment(input: string, allowColon: boolean): string {
  const normalized = input
    .normalize('NFKC')
    .replace(/["'“”‘’`\[\]]+/g, ' ')
    .replace(/[^a-zA-Z0-9:\-]+/g, ' ')
    .trim()
    .toLowerCase();

  if (!normalized) return '';

  let slug = normalized
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!allowColon) {
    slug = slug.replace(/:/g, '-');
  } else {
    slug = slug.replace(/:-/g, ':');
  }

  return slug;
}

function normalizeTarget(rawTarget: string): NormalizedTarget | null {
  if (!rawTarget) return null;
  let working = rawTarget.trim();
  if (!working) return null;

  if (PROTOCOL_RELATIVE_REGEX.test(working)) {
    working = working.replace(PROTOCOL_RELATIVE_REGEX, 'https://');
  }

  const hasExplicitHttp = HTTP_PREFIX_REGEX.test(working);
  if (hasExplicitHttp && !SITE_DOMAIN_REGEX.test(working)) {
    return null;
  }

  working = working.replace(SITE_DOMAIN_REGEX, '');

  if (working.startsWith('*')) {
    working = working.slice(1).trim();
  }

  if (INVALID_PREFIXES.test(working)) {
    return null;
  }

  let fragment: string | null = null;
  const hashIndex = working.indexOf('#');
  if (hashIndex >= 0) {
    fragment = working.slice(hashIndex + 1).trim() || null;
    working = working.slice(0, hashIndex);
  }

  working = working.trim();
  if (!working) {
    return null;
  }

  if (LOCAL_FILES_REGEX.test(working)) {
    return null;
  }

  let path: string | null = null;

  if (working.startsWith('/')) {
    const rawSegments = working.replace(/^\/+/g, '').split('/');
    const normalizedSegments: string[] = [];
    for (let i = 0; i < rawSegments.length; i += 1) {
      const segment = rawSegments[i]?.trim() ?? '';
      if (!segment) continue;
      if (LOCAL_FILES_REGEX.test(segment)) {
        return null;
      }
      const allowColon = i === 0;
      const slug = slugifySegment(segment, allowColon);
      if (!slug) continue;
      normalizedSegments.push(slug);
    }
    if (normalizedSegments.length === 0) {
      return null;
    }
    path = `/${normalizedSegments.join('/')}`;
  } else {
    const slug = slugifySegment(working, true);
    if (!slug) {
      return null;
    }
    path = `/${slug.replace(/:-/g, ':')}`;
  }

  if (!path || path === '/' || LOCAL_FILES_REGEX.test(path)) {
    return null;
  }

  return {
    path,
    fragment,
    rawTarget: rawTarget.trim()
  };
}

function addDisplayValue(set: Set<string>, value: string | undefined | null) {
  if (!value) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (set.has(trimmed)) return;
  if (set.size >= MAX_DISPLAY_VARIANTS) return;
  set.add(trimmed);
}

export class PageReferenceService {
  constructor(private prisma: PrismaClient) {}

  extractInternalReferences(source: string | null | undefined): PageReferenceCandidate[] {
    if (!source) return [];

    const map = new Map<string, CandidateAccumulator>();

    const ensureEntry = (
      key: string,
      linkType: LinkType,
      target: NormalizedTarget,
      rawText: string
    ): CandidateAccumulator => {
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          linkType,
          targetPath: target.path,
          targetFragment: target.fragment ?? null,
          rawTarget: target.rawTarget,
          rawText,
          occurrence: 0,
          displays: new Set<string>()
        };
        map.set(key, entry);
      }
      return entry;
    };

    const triplePattern = /\[\[\[([\s\S]*?)\]\]\]/g;
    let tripleMatch: RegExpExecArray | null;
    while ((tripleMatch = triplePattern.exec(source)) !== null) {
      const rawText = tripleMatch[0];
      const inner = tripleMatch[1] ?? '';
      if (!inner) continue;

      const pipeIndex = inner.indexOf('|');
      let target = inner;
      let display: string | undefined;
      if (pipeIndex >= 0) {
        target = inner.slice(0, pipeIndex);
        display = inner.slice(pipeIndex + 1);
      }
      const normalized = normalizeTarget(target);
      if (!normalized) continue;

      const key = `TRIPLE|${normalized.path}|${normalized.fragment ?? ''}`;
      const entry = ensureEntry(key, 'TRIPLE', normalized, rawText);
      entry.occurrence += 1;
      addDisplayValue(entry.displays, display);
    }

    const shortPattern = /\[(?!\[)([^\]\s]+)\s+([^\]]+?)\]/g;
    let shortMatch: RegExpExecArray | null;
    while ((shortMatch = shortPattern.exec(source)) !== null) {
      const rawText = shortMatch[0];
      const target = shortMatch[1];
      const display = shortMatch[2];

      const normalized = normalizeTarget(target);
      if (!normalized) continue;

      const key = `SHORT|${normalized.path}|${normalized.fragment ?? ''}`;
      const entry = ensureEntry(key, 'SHORT', normalized, rawText);
      entry.occurrence += 1;
      addDisplayValue(entry.displays, display);
    }

    const directPattern = /https?:\/\/(?:www\.)?scp-wiki-cn\.wikidot\.com\/[^\s"'<>]+/gi;
    let directMatch: RegExpExecArray | null;
    while ((directMatch = directPattern.exec(source)) !== null) {
      const rawText = directMatch[0];
      const startIndex = directMatch.index ?? source.indexOf(rawText);
      if (startIndex > 0 && source[startIndex - 1] === '[') {
        continue;
      }
      const normalized = normalizeTarget(rawText);
      if (!normalized) continue;

      const key = `DIRECT|${normalized.path}|${normalized.fragment ?? ''}`;
      const entry = ensureEntry(key, 'DIRECT', normalized, rawText);
      entry.occurrence += 1;
    }

    return Array.from(map.values()).map((item) => ({
      linkType: item.linkType,
      targetPath: item.targetPath,
      targetFragment: item.targetFragment,
      rawTarget: item.rawTarget,
      rawText: item.rawText,
      occurrence: item.occurrence,
      displayTexts: Array.from(item.displays)
    }));
  }

  async syncPageReferences(pageVersionId: number, source: string | null | undefined): Promise<void> {
    const references = this.extractInternalReferences(source);

    await this.prisma.$transaction(async (tx) => {
      const delegate = (tx as unknown as { pageReference: any }).pageReference;
      await delegate.deleteMany({ where: { pageVersionId } });
      if (references.length === 0) {
        return;
      }
      for (const ref of references) {
        await delegate.create({
          data: {
            pageVersionId,
            linkType: ref.linkType,
            targetPath: ref.targetPath,
            targetFragment: ref.targetFragment ?? null,
            displayTexts: ref.displayTexts,
            rawTarget: ref.rawTarget ?? null,
            rawText: ref.rawText ?? null,
            occurrence: ref.occurrence
          }
        });
      }
    });

    Logger.debug(`📚 Synced ${references.length} page references for PageVersion ${pageVersionId}`);
  }
}
