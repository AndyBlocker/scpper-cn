import { join } from "node:path";
import fs from "fs-extra";
import { cfg } from "../config.js";
import { AvatarMeta } from "../types.js";

function bucketPath(userid: string) {
  const pad = userid.padStart(8, "0");
  const p = join(cfg.avatarRoot, pad.slice(0,2), pad.slice(2,4), pad.slice(4,6));
  return { dir: p, base: userid };
}

export function paths(userid: string) {
  const { dir, base } = bucketPath(userid);
  return {
    dir,
    bin: join(dir, `${base}.bin`),
    meta: join(dir, `${base}.meta.json`)
  };
}

export async function readMeta(userid: string): Promise<AvatarMeta | null> {
  const { meta } = paths(userid);
  if (!await fs.pathExists(meta)) return null;
  try {
    const data = await fs.readJson(meta);
    return data;
  } catch {
    return null;
  }
}

export async function writeMeta(userid: string, m: AvatarMeta) {
  const { dir, meta } = paths(userid);
  await fs.ensureDir(dir);
  await fs.writeJson(meta, m, { spaces: 2 });
}

export async function readBinStat(userid: string) {
  const { bin } = paths(userid);
  try {
    const st = await fs.stat(bin);
    return st;
  } catch {
    return null;
  }
}

export async function readBinStream(userid: string) {
  const { bin } = paths(userid);
  return fs.createReadStream(bin);
}

export async function atomicWriteBin(userid: string, buf: Buffer) {
  const { dir, bin } = paths(userid);
  await fs.ensureDir(dir);
  const tmp = bin + ".tmp";
  await fs.writeFile(tmp, buf);
  await fs.move(tmp, bin, { overwrite: true });
}

export async function touchAccess(userid: string) {
  const m = (await readMeta(userid)) ?? { userid } as AvatarMeta;
  m.last_access_at = new Date().toISOString();
  await writeMeta(userid, m);
}

export function isFresh(meta: AvatarMeta, now = new Date()) {
  if (!meta.next_revalidate_at) return false;
  return new Date(meta.next_revalidate_at).getTime() > now.getTime();
}

export function nextRevalidateFrom(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + cfg.ttlDays);
  return d.toISOString();
}


