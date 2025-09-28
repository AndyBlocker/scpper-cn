import { AvatarMeta } from "../types.js";
import { cfg } from "../config.js";
import { log } from "../logger.js";
import { singleFlight } from "../utils/singleFlight.js";
import { readMeta, writeMeta, atomicWriteBin, nextRevalidateFrom } from "./cacheStore.js";
import { getCloudfront, headCloudfront, resolveWikidot } from "./upstream.js";

function nowIso() { return new Date().toISOString(); }

function computeCooldown(meta: AvatarMeta, errCount: number) {
  const min = cfg.backoffBaseMin;
  const maxMs = cfg.backoffMaxHours * 3600 * 1000;
  const waitMs = Math.min(maxMs, Math.pow(2, Math.max(0, errCount - 1)) * min * 60 * 1000);
  return new Date(Date.now() + waitMs).toISOString();
}

export async function refresh(userid: string, forceResolve = false): Promise<AvatarMeta> {
  return singleFlight(`refresh:${userid}`, async () => {
    let meta: AvatarMeta = (await readMeta(userid)) ?? { userid, error_count: 0, cooldown_until: null } as AvatarMeta;
    const now = new Date();

    if (meta.cooldown_until && new Date(meta.cooldown_until) > now) {
      return meta;
    }

    const needResolve =
      forceResolve ||
      !meta.source_url ||
      !meta.last_resolve_at ||
      (new Date(meta.last_resolve_at).getTime() + cfg.resolveTtlDays * 86400_000 < now.getTime());

    try {
      if (needResolve) {
        const url = await resolveWikidot(userid);
        meta.source_url = url;
        meta.last_resolve_at = nowIso();
        await writeMeta(userid, meta);
      }

      if (!meta.source_url) throw new Error("no source_url");

      const head = await headCloudfront(meta.source_url, meta.etag ?? undefined, meta.last_modified ?? undefined);
      if (head.status === 304) {
        meta.fetched_at = nowIso();
        meta.next_revalidate_at = nextRevalidateFrom(now);
        meta.error_count = 0;
        meta.cooldown_until = null;
        await writeMeta(userid, meta);
        return meta;
      }

      if (head.status !== 200) {
        throw new Error(`head ${head.status}`);
      }

      const ct = String(head.headers["content-type"] || "");
      const lenStr = head.headers["content-length"] as string | undefined;
      const len = lenStr ? Number(lenStr) : undefined;
      if (!ct.startsWith("image/")) throw new Error(`bad content-type ${ct}`);
      if (len && len > cfg.maxBytes) throw new Error(`too large ${len}`);

      const get = await getCloudfront(meta.source_url);
      if (get.statusCode !== 200) {
        throw new Error(`get ${get.statusCode}`);
      }
      const bufs: Buffer[] = [];
      for await (const c of get.body) bufs.push(Buffer.from(c));
      const buf = Buffer.concat(bufs);
      if (buf.length > cfg.maxBytes) throw new Error(`too large body ${buf.length}`);

      await atomicWriteBin(userid, buf);
      meta.bytes = buf.length;
      meta.content_type = ct;
      meta.etag = String(get.headers["etag"] || head.headers["etag"] || "");
      meta.last_modified = String(get.headers["last-modified"] || head.headers["last-modified"] || "") || null;
      meta.fetched_at = nowIso();
      meta.next_revalidate_at = nextRevalidateFrom(now);
      meta.error_count = 0;
      meta.cooldown_until = null;
      await writeMeta(userid, meta);
      return meta;

    } catch (e: any) {
      log.warn({ userid, err: String(e) }, "refresh failed");
      meta.error_count = (meta.error_count ?? 0) + 1;
      meta.cooldown_until = computeCooldown(meta, meta.error_count);
      await writeMeta(userid, meta);
      return meta;
    }
  });
}


