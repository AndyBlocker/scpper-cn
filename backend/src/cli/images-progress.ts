import type { PageVersionImageStatus, ImageIngestJobStatus } from '@prisma/client';
import { getPrismaClient, disconnectPrisma } from '../utils/db-connection.js';

type ProgressOptions = {
  json?: boolean;
};

type CountByStatus<T extends string> = Record<T, number>;

interface ProgressSnapshot {
  totalEligible: number;
  withImages: number;
  withoutImages: number;
  scanCompletionRatio: number | null;
  latestEligibleId: number | null;
  latestProcessedId: number | null;
  latestProcessedUrl: string | null;
  latestProcessedTitle: string | null;
  latestProcessedQueuedAt: string | null;
  firstPendingId: number | null;
  firstPendingUrl: string | null;
  firstPendingTitle: string | null;
  imageStatusCounts: CountByStatus<PageVersionImageStatus>;
  ingestStatusCounts: CountByStatus<ImageIngestJobStatus>;
}

const IMAGE_STATUS_VALUES: PageVersionImageStatus[] = [
  'PENDING',
  'QUEUED',
  'FETCHING',
  'RESOLVED',
  'FAILED'
];

const INGEST_STATUS_VALUES: ImageIngestJobStatus[] = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED'
];

const toStatusMap = <T extends string>(keys: T[]): CountByStatus<T> => {
  return keys.reduce((map, key) => {
    map[key] = 0;
    return map;
  }, {} as CountByStatus<T>);
};

const formatPercent = (value: number, total: number): string => {
  if (!total) return '0%';
  return `${((value / total) * 100).toFixed(2)}%`;
};

const formatRatio = (ratio: number | null): string => {
  if (ratio == null) return '未知';
  return `${(ratio * 100).toFixed(2)}%`;
};

const formatMaybeNumber = (value: number | null): string => {
  return value == null ? '未知' : value.toLocaleString();
};

const formatMaybeDate = (value: string | null): string => {
  if (!value) return '未知';
  try {
    return new Date(value).toISOString();
  } catch {
    return value;
  }
};

async function collectSnapshot(): Promise<ProgressSnapshot> {
  const prisma = getPrismaClient();

  const [
    totalEligible,
    withImages,
    imageStatusRaw,
    ingestStatusRaw,
    latestEligible,
    latestProcessed,
    firstPending
  ] = await Promise.all([
    prisma.pageVersion.count({ where: { source: { not: null } } }),
    prisma.pageVersion.count({ where: { source: { not: null }, images: { some: {} } } }),
    prisma.pageVersionImage.groupBy({
      by: ['status'],
      _count: { status: true }
    }),
    prisma.imageIngestJob.groupBy({
      by: ['status'],
      _count: { status: true }
    }),
    prisma.pageVersion.findFirst({
      where: { source: { not: null } },
      orderBy: { id: 'desc' },
      select: { id: true }
    }),
    prisma.pageVersionImage.findFirst({
      orderBy: { pageVersionId: 'desc' },
      select: {
        pageVersionId: true,
        lastQueuedAt: true,
        pageVersion: {
          select: {
            id: true,
            title: true,
            page: {
              select: {
                id: true,
                currentUrl: true,
                url: true
              }
            }
          }
        }
      }
    }),
    prisma.pageVersion.findFirst({
      where: { source: { not: null }, images: { none: {} } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        title: true,
        page: {
          select: {
            currentUrl: true,
            url: true
          }
        }
      }
    })
  ]);

  const withoutImages = Math.max(0, totalEligible - withImages);

  const imageStatusCounts = toStatusMap(IMAGE_STATUS_VALUES);
  for (const entry of imageStatusRaw) {
    imageStatusCounts[entry.status] = entry._count.status;
  }

  const ingestStatusCounts = toStatusMap(INGEST_STATUS_VALUES);
  for (const entry of ingestStatusRaw) {
    ingestStatusCounts[entry.status] = entry._count.status;
  }

  const latestEligibleId = latestEligible?.id ?? null;
  const latestProcessedId = latestProcessed?.pageVersionId ?? null;
  const scanCompletionRatio = latestEligibleId && latestProcessedId
    ? Math.min(1, latestProcessedId / latestEligibleId)
    : null;

  return {
    totalEligible,
    withImages,
    withoutImages,
    scanCompletionRatio,
    latestEligibleId,
    latestProcessedId,
    latestProcessedUrl: latestProcessed?.pageVersion?.page?.currentUrl
      ?? latestProcessed?.pageVersion?.page?.url
      ?? null,
    latestProcessedTitle: latestProcessed?.pageVersion?.title ?? null,
    latestProcessedQueuedAt: latestProcessed?.lastQueuedAt?.toISOString() ?? null,
    firstPendingId: firstPending?.id ?? null,
    firstPendingUrl: firstPending?.page?.currentUrl ?? firstPending?.page?.url ?? null,
    firstPendingTitle: firstPending?.title ?? null,
    imageStatusCounts,
    ingestStatusCounts
  };
}

const printStatusBlock = <T extends string>(label: string, counts: CountByStatus<T>) => {
  console.log(`- ${label}`);
  const entries = Object.entries(counts) as Array<[T, number]>;
  for (const [status, count] of entries) {
    console.log(`  - ${status}: ${count.toLocaleString()}`);
  }
};

const printSnapshot = (snapshot: ProgressSnapshot) => {
  console.log('PageVersion 图片提取进度汇总');
  console.log('--------------------------------');
  console.log(`可处理的 PageVersion 总数: ${snapshot.totalEligible.toLocaleString()}`);
  console.log(`已提取图片的 PageVersion: ${snapshot.withImages.toLocaleString()} (${formatPercent(snapshot.withImages, snapshot.totalEligible)})`);
  console.log(`尚未提取图片的 PageVersion: ${snapshot.withoutImages.toLocaleString()}`);
  console.log(`按 ID 估算的扫描进度: ${formatRatio(snapshot.scanCompletionRatio)} (最新 ${formatMaybeNumber(snapshot.latestProcessedId)} / 目标 ${formatMaybeNumber(snapshot.latestEligibleId)})`);

  if (snapshot.latestProcessedId != null) {
    console.log(`最近处理的 PageVersion: #${snapshot.latestProcessedId} ${snapshot.latestProcessedTitle ?? ''}`.trim());
    console.log(`  URL: ${snapshot.latestProcessedUrl ?? '未知'}`);
    console.log(`  最近入队时间: ${formatMaybeDate(snapshot.latestProcessedQueuedAt)}`);
  } else {
    console.log('最近处理的 PageVersion: 暂无记录');
  }

  if (snapshot.firstPendingId != null) {
    console.log(`下一个缺少图片的 PageVersion: #${snapshot.firstPendingId} ${snapshot.firstPendingTitle ?? ''}`.trim());
    console.log(`  URL: ${snapshot.firstPendingUrl ?? '未知'}`);
  } else {
    console.log('下一个缺少图片的 PageVersion: 未找到（可能全部已有记录或尚无数据）');
  }

  printStatusBlock('图片记录状态分布', snapshot.imageStatusCounts);
  printStatusBlock('采集任务状态分布', snapshot.ingestStatusCounts);

  console.log('\n提示: 没有任何图片的 PageVersion 会保持空记录，若比率长期停留请结合最新 ID 判断是否已扫描到末尾。');
};

export async function showImagesProgress(options: ProgressOptions = {}): Promise<void> {
  try {
    const snapshot = await collectSnapshot();
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      printSnapshot(snapshot);
    }
  } finally {
    await disconnectPrisma();
  }
}
