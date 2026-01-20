// src/http-scrape-thread.js
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetch, setGlobalDispatcher, ProxyAgent } from 'undici';
import { CookieJar } from 'tough-cookie';
import { load } from 'cheerio';

const COOKIE_FILE_URL = new URL('../.auth/wikidot.cookies.json', import.meta.url);
const COOKIE_FILE = fileURLToPath(COOKIE_FILE_URL);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

function assertAllowedThreadUrl(url) {
  const u = new URL(url);
  const allow = new Set(['scp-wiki-cn.wikidot.com', 'www.wikidot.com']);
  if (u.protocol !== 'https:') throw new Error('Only https allowed');
  if (!allow.has(u.hostname)) throw new Error(`Disallowed host: ${u.hostname}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { tries = 4, baseMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      lastErr = e;
      const backoff = baseMs * 2 ** i + Math.floor(Math.random() * 200);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function loadJar() {
  const raw = await fs.readFile(COOKIE_FILE, 'utf-8');
  return CookieJar.fromJSON(JSON.parse(raw));
}

async function scrapeThread(threadUrl) {
  assertAllowedThreadUrl(threadUrl);

  // 代理（mihomo）
  const proxy = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
  setGlobalDispatcher(new ProxyAgent(proxy));

  const jar = await loadJar();

  const html = await withRetry(async () => {
    const cookieHeader = await jar.getCookieString(threadUrl);
    const res = await fetch(threadUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'SCPper-Forum-Crawler/0.1',
        'Cookie': cookieHeader,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    // 把响应 Set-Cookie 写回 jar（保持会话活跃）
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) await jar.setCookie(sc, threadUrl);

    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${threadUrl}`);

    // 简单判断是否被踢回登录页
    if (text.includes('default:login') && text.includes('name="login"')) {
      throw new Error('Not logged in (redirected to login). Run http-login first.');
    }
    return text;
  });

  const $ = load(html);
  const posts = [];

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

    $(container).children('.post-container').each((_, child) => parseContainer(child, postId));
  }

  $('#thread-container > .post-container').each((_, c) => parseContainer(c, null));

  // 保存更新后的 cookie（会话滚动）
  await fs.writeFile(COOKIE_FILE, JSON.stringify(jar.toJSON(), null, 2), 'utf-8');
  await fs.chmod(COOKIE_FILE, 0o600).catch(() => {});

  return posts;
}

async function main() {
  const threadUrl = requireEnv('THREAD_URL');
  const posts = await scrapeThread(threadUrl);
  console.log(JSON.stringify({ threadUrl, count: posts.length, posts }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
