import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@ukwhatn/wikidot';
import { setupProxy } from './bootstrap-proxy.js';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

function optEnv(name) {
  return process.env[name] || undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSiteName(siteName) {
  return siteName.replace(/[^a-z0-9_-]/gi, '_');
}

function threadToDTO(thread) {
  return {
    id: thread.id,
    title: thread.title ?? '',
    description: thread.description ?? '',
    createdAt: thread.createdAt ? new Date(thread.createdAt).toISOString() : null,
    createdBy: thread.createdBy
      ? { id: thread.createdBy.id, name: thread.createdBy.name, userType: thread.createdBy.userType }
      : null,
    postCount: thread.postCount ?? 0,
    url: thread.getUrl?.() || null,
    categoryId: thread.category?.id ?? null,
    categoryTitle: thread.category?.title ?? null,
  };
}

function postToDTO(post) {
  return {
    id: post.id,
    parentId: post.parentId ?? null,
    title: post.title ?? '',
    author: post.createdBy
      ? { id: post.createdBy.id, name: post.createdBy.name, userType: post.createdBy.userType }
      : null,
    createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : null,
    editedAt: post.editedAt ? new Date(post.editedAt).toISOString() : null,
    textHtml: post.text ?? '',
  };
}

async function ensureOutDir(siteName) {
  const outDir = path.join('out', safeSiteName(siteName), 'threads');
  await fs.mkdir(outDir, { recursive: true });
  return outDir;
}

async function createClient() {
  const username = optEnv('WIKIDOT_USERNAME');
  const password = optEnv('WIKIDOT_PASSWORD');
  const clientRes = username && password
    ? await Client.create({ username, password })
    : Client.createAnonymous();
  if (!clientRes.isOk()) throw clientRes.error;
  return clientRes.value;
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function crawlSite(siteName) {
  const client = await createClient();
  const outDir = await ensureOutDir(siteName);
  const indexPath = path.join('out', safeSiteName(siteName), 'index.json');

  try {
    const siteRes = await client.site.get(siteName);
    if (!siteRes.isOk()) throw siteRes.error;
    const site = siteRes.value;

    const categoriesRes = await site.forum.getCategories();
    if (!categoriesRes.isOk()) throw categoriesRes.error;
    const categories = categoriesRes.value;

    const siteIndex = {
      site: {
        unixName: site.unixName,
        title: site.title,
        domain: site.domain,
      },
      categories: categories.map((cat) => ({
        id: cat.id,
        title: cat.title,
        description: cat.description,
        threadsCount: cat.threadsCount,
        postsCount: cat.postsCount,
      })),
      generatedAt: new Date().toISOString(),
    };

    await writeJson(indexPath, siteIndex);

    for (const category of categories) {
      const threadsRes = await category.getThreads();
      if (!threadsRes.isOk()) throw threadsRes.error;
      const threads = threadsRes.value;

      for (const thread of threads) {
        const threadPath = path.join(outDir, `thread-${thread.id}.json`);
        const existing = await readJsonIfExists(threadPath);
        if (existing && existing.thread?.postCount === thread.postCount) {
          continue;
        }

        const postsRes = await thread.getPosts();
        if (!postsRes.isOk()) throw postsRes.error;
        const posts = postsRes.value;

        const dto = {
          thread: threadToDTO(thread),
          posts: posts.map(postToDTO),
          generatedAt: new Date().toISOString(),
        };

        await writeJson(threadPath, dto);
        await sleep(800);
      }
    }
  } finally {
    try {
      const closeRes = await client.close();
      if (!closeRes.isOk()) {
        console.warn('client.close failed:', closeRes.error?.message || closeRes.error);
      }
    } catch (err) {
      console.warn('client.close threw:', err);
    }
  }
}

async function main() {
  setupProxy();
  const siteName = requireEnv('SITE_NAME');
  await crawlSite(siteName);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
