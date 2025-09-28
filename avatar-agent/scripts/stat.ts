import fs from "fs-extra";
import { join } from "node:path";
import { cfg } from "../src/config.js";

let count=0, bytes=0;
async function walk(dir: string) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (p.endsWith(".bin")) { count++; bytes += (await fs.stat(p)).size; }
  }
}

function formatBytes(n: number) {
  const units = ["B","KB","MB","GB","TB"]; let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

(async () => {
  const exists = await fs.pathExists(cfg.avatarRoot);
  if (exists) {
    await walk(cfg.avatarRoot);
  }
  const pretty = process.argv.includes("--pretty");
  if (pretty) {
    console.log(`[avatar-agent] root=${cfg.avatarRoot}`);
    console.log(`[avatar-agent] files=${count} bytes=${bytes} (${formatBytes(bytes)})`);
  } else {
    console.log(JSON.stringify({ count, bytes, root: cfg.avatarRoot }, null, 2));
  }
  process.exit(0);
})();


