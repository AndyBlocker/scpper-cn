import Fastify from "fastify";
import { cfg } from "./config.js";
import avatarRoutes from "./routes/avatar.js";
import healthRoutes from "./routes/health.js";
import fs from "fs-extra";

async function ensureDefaultAvatar() {
  const exists = await fs.pathExists(cfg.defaultAvatar);
  if (exists) return;
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/yoP6S0AAAAASUVORK5CYII=";
  const buf = Buffer.from(base64, "base64");
  await fs.writeFile(cfg.defaultAvatar, buf);
}

export async function buildServer() {
  const app = Fastify({ logger: false });
  await fs.ensureDir(cfg.avatarRoot);
  await ensureDefaultAvatar();
  app.register(healthRoutes);
  app.register(avatarRoutes);
  return app;
}


