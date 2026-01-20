// src/scrape.js
import { request as playwrightRequest } from 'playwright';
import { load } from 'cheerio';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const AUTH_STATE_PATH = fileURLToPath(new URL('../.auth/wikidot.storage.json', import.meta.url));

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

function assertAllowedThreadUrl(url) {
  const u = new URL(url);
  // SSRF 防护：只允许你需要的域名（按你实际情况加）
  const allow = new Set(['www.wikidot.com', 'scp-wiki-cn.wikidot.com']);
  if (!allow.has(u.hostname)) throw new Error(`Disallowed host: ${u.hostname}`);
  if (u.protocol !== 'https:') throw new Error('Only https allowed');
}

export async function scrapeThread(threadUrl) {
  assertAllowedThreadUrl(threadUrl);

  const proxyServer = process.env.PW_PROXY || 'http://127.0.0.1:7890';

  const api = await playwrightRequest.newContext({
    proxy: proxyServer ? { server: proxyServer } : undefined,
    storageState: AUTH_STATE_PATH, // 复用登录态:contentReference[oaicite:10]{index=10}
    timeout: 60000,                // APIRequestContext 默认 30s，可放宽:contentReference[oaicite:11]{index=11}
    extraHTTPHeaders: {
      'User-Agent': 'SCPper-Forum-Crawler/0.1',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });

  try {
    const resp = await api.get(threadUrl, { maxRedirects: 10 });
    const status = resp.status();
    const html = await resp.text();

    if (status >= 400) {
      throw new Error(`HTTP ${status} for ${threadUrl}`);
    }

    const $ = load(html);

    const posts = [];

    // 你的解析逻辑基本OK，但这里有两个小 bug/低效点：
    // 1) currentPost.find('.post .author a') 其实会在 .post 内再找 .post，容易找不到
    // 2) 递归层级太深时可能爆栈（极端楼中楼），可改迭代；先保留递归也行

    function parseContainer(container, parentId = null) {
      const currentPost = $(container).children('.post').first();
      if (!currentPost.length) return;

      const rawId = currentPost.attr('id') || '';
      const postId = rawId.replace('post-', '');

      const author =
        currentPost.find('.author a').first().text().trim() ||
        currentPost.find('.printuser').first().text().trim() ||
        '';

      const contentHtml = currentPost.find('.content').first().html() || '';

      const odate = currentPost.find('.odate').first();
      const timestamp = odate.attr('title') || odate.text().trim() || '';

      posts.push({ postId, parentId, author, timestamp, contentHtml });

      $(container).children('.post-container').each((_, child) => {
        parseContainer(child, postId);
      });
    }

    $('#thread-container > .post-container').each((_, c) => parseContainer(c, null));
    return posts;
  } finally {
    // 非常重要：释放 APIRequestContext 占用的内存:contentReference[oaicite:12]{index=12}
    await api.dispose();
  }
}

export async function main() {
  const threadUrl = requireEnv('THREAD_URL');
  const posts = await scrapeThread(threadUrl);
  console.log(JSON.stringify({ threadUrl, count: posts.length, posts }, null, 2));
}

// node src/scrape.js
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
