import { cfg } from "../config.js";
import { httpHEAD, httpGET } from "../utils/http.js";
import { RateLimiter } from "./rateLimiter.js";
import { log } from "../logger.js";
import { request } from "undici";

export const cfLimiter = new RateLimiter(cfg.cfRateRps, Math.max(1, Math.ceil(cfg.cfRateRps)));
export const wdLimiter = new RateLimiter(cfg.wikidotRateRps, 1);

export async function resolveWikidot(userid: string): Promise<string> {
  await wdLimiter.take();
  const url = `${cfg.upstreamWikidot}?userid=${encodeURIComponent(userid)}`;
  const res = await request(url, { method: "GET", maxRedirections: 0, headersTimeout: cfg.timeoutHeadMs, bodyTimeout: cfg.timeoutHeadMs });
  if (res.statusCode !== 302) throw new Error(`wikidot expected 302, got ${res.statusCode}`);
  const loc = res.headers["location"] as string | undefined;
  if (!loc) throw new Error("wikidot no Location");
  const u = new URL(loc);
  const allowed = cfg.upstreamAllowedHosts;
  const wildcard = allowed.includes("*");
  if (allowed.length > 0 && !wildcard && !allowed.includes(u.hostname)) {
    throw new Error(`Location host not allowed: ${u.hostname}`);
  }
  return u.toString();
}

export async function headCloudfront(sourceUrl: string, etag?: string | null, lastModified?: string | null) {
  await cfLimiter.take();
  const headers: Record<string,string> = {};
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;
  return httpHEAD(sourceUrl, cfg.timeoutHeadMs, headers);
}

export async function getCloudfront(sourceUrl: string) {
  await cfLimiter.take();
  return httpGET(sourceUrl, cfg.timeoutGetMs);
}


