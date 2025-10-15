// @ts-check
import { parentPort, workerData } from 'worker_threads';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * @typedef {{
 *   sourcePageId: number;
 *   targetPath: string;
 *   weight: number;
 * }} WorkerEdge
 */

const postMessage = (message) => {
  if (!parentPort) {
    throw new Error('reference-graph-worker must have a parentPort');
  }
  parentPort.postMessage(message);
};

const run = async () => {
  const task = /** @type {{ pageIds?: unknown }} */ (workerData);
  const pageIds = Array.isArray(task?.pageIds)
    ? task.pageIds.filter((id) => Number.isInteger(id) && id > 0)
    : [];

  if (pageIds.length === 0) {
    postMessage({ ok: true, edges: /** @type {WorkerEdge[]} */([]) });
    return;
  }

  const prisma = new PrismaClient();

  try {
    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT
        pv."pageId"      AS source_page_id,
        pr."targetPath"  AS target_path,
        SUM(pr."occurrence")::bigint AS weight
      FROM "PageReference" pr
      JOIN "PageVersion" pv ON pv.id = pr."pageVersionId"
      WHERE pv."validTo" IS NULL
        AND pv."pageId" IN (${Prisma.join(pageIds.map((id) => Prisma.sql`${id}`))})
      GROUP BY pv."pageId", pr."targetPath"
      HAVING SUM(pr."occurrence") > 0
    `);

    /** @type {WorkerEdge[]} */
    const edges = rows.map((row) => {
      const value = row.weight;
      const numeric = typeof value === 'bigint'
        ? Number(value)
        : (typeof value === 'number' ? value : 0);
      return {
        sourcePageId: Number(row.source_page_id),
        targetPath: String(row.target_path ?? ''),
        weight: numeric
      };
    });

    postMessage({ ok: true, edges });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ ok: false, error: message });
  } finally {
    await prisma.$disconnect();
  }
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  postMessage({ ok: false, error: message });
});
