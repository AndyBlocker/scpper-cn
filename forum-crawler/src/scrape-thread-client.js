// src/scrape-thread-client.js
import fs from 'node:fs/promises';
import { Client } from '@ukwhatn/wikidot';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}
function optEnv(name) {
  return process.env[name] || undefined;
}

function setupProxy() {
  const proxy = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
  setGlobalDispatcher(new ProxyAgent(proxy));
}

function parseThreadId(threadUrl) {
  const m = threadUrl.match(/\/forum\/t-(\d+)/);
  if (!m) throw new Error(`Cannot parse thread id from url: ${threadUrl}`);
  return Number(m[1]);
}

function inferSiteNameFromUrl(threadUrl) {
  const u = new URL(threadUrl);
  return u.hostname.replace(/\.wikidot\.com$/i, '');
}

// 把 ForumPost -> 纯 JSON DTO（避免循环引用）
function postToDTO(p) {
  return {
    id: p.id,
    parentId: p.parentId ?? null,
    title: p.title ?? '',
    // createdBy 是 AbstractUser，也可能带方法，但一般不循环；保险起见只拿字段
    author: p.createdBy ? { id: p.createdBy.id, name: p.createdBy.name, userType: p.createdBy.userType } : null,
    createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    editedAt: p.editedAt ? new Date(p.editedAt).toISOString() : null,
    textHtml: p.text ?? '', // 文档写的是 HTML 内容
  };
}

async function main() {
  setupProxy();

  const threadUrl = requireEnv('THREAD_URL');
  const siteName = inferSiteNameFromUrl(threadUrl);
  const threadId = parseThreadId(threadUrl);

  const username = optEnv('WIKIDOT_USERNAME');
  const password = optEnv('WIKIDOT_PASSWORD');

  // 可匿名读；需要登录才传账号
  const clientRes = username && password
    ? await Client.create({ username, password })
    : Client.createAnonymous();

  if (!clientRes.isOk()) throw clientRes.error;
  const client = clientRes.value;

  try {
    const siteRes = await client.site.get(siteName);
    if (!siteRes.isOk()) throw siteRes.error;
    const site = siteRes.value;

    const threadRes = await site.forum.getThread(threadId);
    if (!threadRes.isOk()) throw threadRes.error;
    const thread = threadRes.value;

    // 关键：用库提供的 getPosts()，拿到 ForumPostCollection
    const postsRes = await thread.getPosts();
    if (!postsRes.isOk()) throw postsRes.error;
    const posts = postsRes.value;

    const dto = {
      thread: {
        id: thread.id,
        title: thread.title ?? '',
        description: thread.description ?? '',
        createdAt: thread.createdAt ? new Date(thread.createdAt).toISOString() : null,
        createdBy: thread.createdBy ? { id: thread.createdBy.id, name: thread.createdBy.name, userType: thread.createdBy.userType } : null,
        postCount: thread.postCount ?? posts.length,
        url: thread.getUrl?.() || threadUrl,
        site: { unixName: site.unixName, title: site.title, domain: site.domain },
      },
      posts: posts.map(postToDTO),
    };

    await fs.mkdir('out', { recursive: true });
    const outPath = `out/thread-${threadId}.json`;
    await fs.writeFile(outPath, JSON.stringify(dto, null, 2), 'utf-8');
    console.log(`Saved ${dto.posts.length} posts to ${outPath}`);
  }    finally {
    try {
      const closeRes = await client.close();
      if (!closeRes.isOk()) {
        console.warn('client.close failed:', closeRes.error?.message || closeRes.error);
      }
    } catch (e) {
      // 极端情况：库内部抛异常
      console.warn('client.close threw:', e);
    }
  }

}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
