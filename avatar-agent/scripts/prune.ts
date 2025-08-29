import fs from "fs-extra";
import { join } from "node:path";
import { cfg } from "../src/config.js";
import { paths } from "../src/services/cacheStore.js";

const now = Date.now();
const keepMs = cfg.pruneKeepDays * 86400_000;

async function walk(dir: string, act: (p: string) => Promise<void>) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, act);
    else await act(p);
  }
}

(async () => {
  let removed = 0;
  await fs.ensureDir(cfg.avatarRoot);
  await walk(cfg.avatarRoot, async (p) => {
    if (!p.endsWith(".meta.json")) return;
    try {
      const meta = await fs.readJson(p);
      const la = new Date(meta.last_access_at || meta.fetched_at || 0).getTime();
      if (now - la > keepMs) {
        const userid = p.split("/").pop()!.replace(".meta.json", "");
        const { bin, meta: metaPath } = paths(userid);
        await fs.remove(bin);
        await fs.remove(metaPath);
        removed++;
      }
    } catch {}
  });
  console.log(`prune done, removed=${removed}`);
  process.exit(0);
})();


