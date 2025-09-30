import { Prisma, PrismaClient } from '@prisma/client';
import { Logger } from '../utils/Logger.js';

const URL_TOKEN_REGEX = /(?:https?:\/\/[^\s"'<>]+|\/\/[^\s"'<>]+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?::\d+)?\/[^\s"'<>]+|local--files[^\s"'<>]+|data:image\/[^,]+,[^\s"'<>]+)/g;
const LEADING_PUNCTUATION = /^[\[({<"'“”‘’]+/;
const TRAILING_PUNCTUATION = /[\])}>"'“”‘’.,;:!?|]+$/;
const FRAGMENT_OR_QUERY = /[?#][^\s"'<>]*$/;
const DOMAIN_WITH_PATH_REGEX = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?::\d+)?\/.+/;
const TRAILING_PROTO_RELATIVE = /^\/\//i;
const HTTP_PREFIX = /^http:\/\//i;
const HTTPS_PREFIX = /^https?:\/\//i;
const LOCAL_FILES_PREFIX = /^local--files\//i;
const IMAGE_EXTENSION_REGEX = new RegExp(`\\.(?:jpe?g|png|gif|webp|bmp|tiff?|ico|svgz?|avif|apng|heic|heif|jfif|pjpeg)$`, 'i');
const DATA_URI_PREFIX = /^data:image\//i;

const PageVersionImageStatus = {
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  FETCHING: 'FETCHING',
  RESOLVED: 'RESOLVED',
  FAILED: 'FAILED'
} as const;

const ImageIngestJobStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
} as const;

type PageVersionImageStatusValue = typeof PageVersionImageStatus[keyof typeof PageVersionImageStatus];
type ImageIngestJobStatusValue = typeof ImageIngestJobStatus[keyof typeof ImageIngestJobStatus];

export interface ExtractedImageCandidate {
  originUrl: string;
  displayUrl: string;
  normalizedUrl: string;
}

interface ExistingImageRecord {
  id: number;
  originUrl: string;
  displayUrl: string | null;
  normalizedUrl: string;
  status: PageVersionImageStatusValue;
  imageAssetId: number | null;
  failureCount: number;
  metadata: Prisma.JsonValue | null;
  ingestJob?: {
    id: number;
    status: ImageIngestJobStatusValue;
    attempts: number;
  } | null;
}

function sanitizeToken(token: string): string {
  const trimmed = token.replace(LEADING_PUNCTUATION, '').replace(TRAILING_PUNCTUATION, '');
  return trimmed;
}

function toNormalizedUrl(sanitized: string): { normalizedUrl: string; displayUrl: string } | null {
  const canonicalDisplay = normalizeForDisplay(sanitized);
  const baseForKey = sanitized.replace(FRAGMENT_OR_QUERY, '').replace(TRAILING_PUNCTUATION, '').toLowerCase();

  let canonical = baseForKey;
  if (!canonical) return null;

  if (DATA_URI_PREFIX.test(canonical)) {
    // data URIs are embedded content; skip to avoid corrupting payloads
    return null;
  }

  if (LOCAL_FILES_PREFIX.test(canonical)) {
    canonical = `https://scp-wiki-cn.wdfiles.com/${canonical}`;
  } else if (HTTPS_PREFIX.test(canonical)) {
    canonical = canonical.replace(HTTP_PREFIX, 'https://');
  } else if (TRAILING_PROTO_RELATIVE.test(canonical)) {
    canonical = canonical.replace(TRAILING_PROTO_RELATIVE, 'https://');
  } else if (DOMAIN_WITH_PATH_REGEX.test(canonical)) {
    canonical = `https://${canonical}`;
  }

  if (!canonical) return null;

  if (
    !canonical.includes('local--files/') &&
    !IMAGE_EXTENSION_REGEX.test(canonical)
  ) {
    return null;
  }

  return { normalizedUrl: canonical, displayUrl: canonicalDisplay };
}

function normalizeForDisplay(sanitized: string): string {
  let display = sanitized;
  if (HTTP_PREFIX.test(display)) {
    display = display.replace(HTTP_PREFIX, 'https://');
  } else if (TRAILING_PROTO_RELATIVE.test(display)) {
    display = display.replace(TRAILING_PROTO_RELATIVE, 'https://');
  } else if (LOCAL_FILES_PREFIX.test(display)) {
    display = `https://scp-wiki-cn.wdfiles.com/${display}`;
  } else if (DOMAIN_WITH_PATH_REGEX.test(display)) {
    display = `https://${display}`;
  }
  return display;
}

function compareCandidates(a: ExtractedImageCandidate, b: ExtractedImageCandidate): number {
  const aHttps = Number(/^https:\/\//i.test(a.displayUrl));
  const bHttps = Number(/^https:\/\//i.test(b.displayUrl));
  if (aHttps !== bHttps) return bHttps - aHttps;

  const aHttp = Number(/^http:\/\//i.test(a.displayUrl));
  const bHttp = Number(/^http:\/\//i.test(b.displayUrl));
  if (aHttp !== bHttp) return bHttp - aHttp;

  const aLocal = Number(/local--files\//i.test(a.displayUrl));
  const bLocal = Number(/local--files\//i.test(b.displayUrl));
  if (aLocal !== bLocal) return aLocal - bLocal;

  if (a.displayUrl.length !== b.displayUrl.length) {
    return a.displayUrl.length - b.displayUrl.length;
  }

  return a.displayUrl.localeCompare(b.displayUrl);
}

export class PageVersionImageService {
  constructor(private prisma: PrismaClient) {}

  extractImageCandidates(source: string | null | undefined): ExtractedImageCandidate[] {
    if (!source) return [];
    const matches = source.match(URL_TOKEN_REGEX);
    if (!matches) return [];

    const map = new Map<string, ExtractedImageCandidate>();

    for (const raw of matches) {
      const sanitized = sanitizeToken(raw);
      if (!sanitized) continue;
      const normalized = toNormalizedUrl(sanitized);
      if (!normalized) continue;

      const candidate: ExtractedImageCandidate = {
        originUrl: sanitized,
        displayUrl: normalized.displayUrl,
        normalizedUrl: normalized.normalizedUrl
      };

      const existing = map.get(candidate.normalizedUrl);
      if (!existing || compareCandidates(candidate, existing) < 0) {
        map.set(candidate.normalizedUrl, candidate);
      }
    }

    return Array.from(map.values());
  }

  async syncPageVersionImages(pageVersionId: number, source: string | null | undefined) {
    const candidates = this.extractImageCandidates(source);
    if (candidates.length === 0) {
      Logger.debug(`🖼️ No image candidates detected for PageVersion ${pageVersionId}`);
    }

    await this.prisma.$transaction(async tx => {
      const existing = await (tx as any).pageVersionImage.findMany({
        where: { pageVersionId },
        include: { ingestJob: true }
      });
      const existingByNormalized = new Map<string, ExistingImageRecord>(
        existing.map(item => [item.normalizedUrl, item as unknown as ExistingImageRecord])
      );
      const seen = new Set<string>();
      const now = new Date();

      for (const candidate of candidates) {
        seen.add(candidate.normalizedUrl);
        const current = existingByNormalized.get(candidate.normalizedUrl);
        if (!current) {
          const created = await (tx as any).pageVersionImage.create({
            data: {
              pageVersionId,
              originUrl: candidate.originUrl,
              displayUrl: candidate.displayUrl,
              normalizedUrl: candidate.normalizedUrl,
              status: PageVersionImageStatus.PENDING,
              lastQueuedAt: now,
              failureCount: 0,
              metadata: {
                detectedAt: now.toISOString()
              } as Prisma.InputJsonValue
            }
          });
          await this.ensureJob(tx, created.id, now, true);
          continue;
        }

        const updates: Record<string, unknown> = {};
        if (current.originUrl !== candidate.originUrl) updates.originUrl = candidate.originUrl;
        if (current.displayUrl !== candidate.displayUrl) updates.displayUrl = candidate.displayUrl;
        if (current.status === PageVersionImageStatus.FAILED) {
          updates.status = PageVersionImageStatus.PENDING;
          updates.failureCount = 0;
          updates.lastError = null;
          updates.lastQueuedAt = now;
        }

        if (Object.keys(updates).length > 0) {
          await (tx as any).pageVersionImage.update({
            where: { id: current.id },
            data: updates
          });
        }

        const shouldQueue = current.imageAssetId == null || current.status === PageVersionImageStatus.FAILED;
        if (shouldQueue) {
          await this.ensureJob(tx, current.id, now, false);
        }
      }

      for (const item of existing) {
        if (seen.has(item.normalizedUrl)) continue;
        const metadata = toMetadataWithFlag(item.metadata, { removedAt: now.toISOString() });
        const updateData: Record<string, unknown> = {
          metadata
        };
        if (item.status !== PageVersionImageStatus.RESOLVED) {
          updateData.status = PageVersionImageStatus.FAILED;
          updateData.lastError = 'Removed from current page source';
        }
        await (tx as any).pageVersionImage.update({
          where: { id: item.id },
          data: updateData
        });
        if (item.ingestJob && item.ingestJob.status !== ImageIngestJobStatus.COMPLETED) {
          await (tx as any).imageIngestJob.update({
            where: { id: item.ingestJob.id },
            data: {
              status: ImageIngestJobStatus.COMPLETED,
              updatedAt: now
            }
          });
        }
      }
    });
  }

  private async ensureJob(tx: Prisma.TransactionClient, pageVersionImageId: number, now: Date, isNew: boolean) {
    await (tx as any).imageIngestJob.upsert({
      where: { pageVersionImageId },
      update: {
        status: ImageIngestJobStatus.PENDING,
        nextRunAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        ...(isNew ? { attempts: 0 } : {})
      },
      create: {
        pageVersionImageId,
        status: ImageIngestJobStatus.PENDING,
        priority: 100,
        attempts: 0,
        nextRunAt: now
      }
    });
  }
}

function toMetadataWithFlag(original: Prisma.JsonValue | null, patch: Record<string, unknown>): Prisma.JsonValue {
  const base = (original && typeof original === 'object' && !Array.isArray(original)) ? { ...original } : {};
  for (const [key, value] of Object.entries(patch)) {
    base[key] = value;
  }
  return base as Prisma.JsonValue;
}
