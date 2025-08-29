import { FastifyInstance } from "fastify";
import { cfg } from "../config.js";
import { readMeta, readBinStat, readBinStream, writeMeta, nextRevalidateFrom, touchAccess } from "../services/cacheStore.js";
import { refresh } from "../services/refresh.js";
import { createReadStream } from "node:fs";

function isDigitId(s: string) { return cfg.userIdRegex.test(s); }

export default async function avatarRoutes(fastify: FastifyInstance) {
  fastify.head("/avatar/:userid", async (req, reply) => {
    const userid = String((req.params as any).userid || "");
    if (!isDigitId(userid)) return reply.code(200).header("X-Avatar-Source", "default").send();
    const meta = await readMeta(userid);
    if (!meta) return reply.code(200).header("X-Avatar-Source", "default").send();
    reply
      .header("ETag", meta.etag ?? "")
      .header("Last-Modified", meta.last_modified ?? "")
      .header("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800")
      .header("X-Avatar-Source", "meta")
      .code(200)
      .send();
  });

  fastify.get("/avatar/:userid", async (req, reply) => {
    const userid = String((req.params as any).userid || "");
    if (!isDigitId(userid)) {
      return serveDefault(reply);
    }

    let meta = await readMeta(userid);
    const st = await readBinStat(userid);

    const now = new Date();
    const fresh = meta && meta.next_revalidate_at && new Date(meta.next_revalidate_at) > now;

    if (!st) {
      try {
        const p = refresh(userid);
        meta = await Promise.race([
          p,
          new Promise<null>(res => setTimeout(() => res(null), cfg.inlineBudgetMs))
        ]) || null;
      } catch {}
      if (!(await readBinStat(userid))) {
        return serveDefault(reply);
      }
    } else if (!fresh) {
      refresh(userid).catch(() => {});
    }

    await touchAccess(userid);
    const m = meta!;
    reply
      .header("Content-Type", m.content_type || "image/png")
      .header("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800")
      .header("ETag", m.etag ?? "")
      .header("Last-Modified", m.last_modified ?? "")
      .header("X-Avatar-Source", fresh ? "local" : "stale");

    const stream = await readBinStream(userid);
    return reply.send(stream);
  });

  function serveDefault(reply: any) {
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "public, max-age=300")
      .header("X-Avatar-Source", "default")
      .send(createReadStream(cfg.defaultAvatar));
  }
}


