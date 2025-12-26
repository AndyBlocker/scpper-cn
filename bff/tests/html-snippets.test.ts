import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';

const queryMock = jest.fn();

process.env.HTML_SNIPPET_DIR = path.resolve(process.cwd(), 'tmp-html-snippets-test');
process.env.HTML_SNIPPET_PUBLIC_BASE = 'http://example.com';
process.env.HTML_SNIPPET_MAX_BYTES = '1024';
process.env.HTML_SNIPPET_TTL_MS = '500';
process.env.HTML_SNIPPET_MAX_TTL_MS = '2000';

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: queryMock
  }))
}));

async function cleanupDir() {
  await fs.rm(process.env.HTML_SNIPPET_DIR as string, { recursive: true, force: true });
}

describe('HTML snippets API', () => {
  beforeEach(async () => {
    queryMock.mockReset();
    await cleanupDir();
  });

  afterAll(async () => {
    await cleanupDir();
  });

  test('stores and serves html snippet with TTL headers', async () => {
    const { createServer } = await import('../src/start');
    const app = await createServer();
    const html = '<p data-test="ok">hello</p>';

    const postRes = await request(app)
      .post('/html-snippet')
      .send({ html })
      .expect(201);

    expect(postRes.body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(postRes.body.url).toBe(`http://example.com/html-snippet/${postRes.body.id}`);
    expect(postRes.body.ttlSeconds).toBeGreaterThan(0);
    expect(postRes.body.persistent).toBe(false);

    const getRes = await request(app)
      .get(`/html-snippet/${postRes.body.id}`)
      .expect(200);

    expect(getRes.text).toBe(html);
    expect(getRes.headers['content-type']).toContain('text/html');
    expect(getRes.headers['x-content-type-options']).toBe('nosniff');
    expect(getRes.headers['cache-control']).toMatch(/max-age=\d+/);
  });

  test('includes forwarded prefix in returned url', async () => {
    const { createServer } = await import('../src/start');
    const app = await createServer();
    const html = '<div>prefixed</div>';

    const postRes = await request(app)
      .post('/api/html-snippet')
      .set('x-forwarded-prefix', '/api')
      .send({ html })
      .expect(201);

    expect(postRes.body.url).toBe(`http://example.com/api/html-snippet/${postRes.body.id}`);
  });

  test('rejects oversized html payload', async () => {
    const { createServer } = await import('../src/start');
    const app = await createServer();
    const tooLarge = 'x'.repeat(2000);

    const res = await request(app)
      .post('/api/html-snippets')
      .send({ html: tooLarge })
      .expect(413);

    expect(res.body.error).toBe('html_too_large');
  });

  test('expires old snippets and deletes payload', async () => {
    const { createServer } = await import('../src/start');
    const app = await createServer();
    const html = '<span>will expire</span>';

    const postRes = await request(app)
      .post('/api/html-snippets')
      .send({ html })
      .expect(201);

    const id = postRes.body.id as string;
    const filePath = path.join(process.env.HTML_SNIPPET_DIR as string, `${id}.json`);
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    parsed.createdAt = Date.now() - 10_000; // force expiration
    await fs.writeFile(filePath, JSON.stringify(parsed), 'utf8');

    await request(app).get(`/api/html-snippets/${id}`).expect(404);
    await expect(fs.access(filePath)).rejects.toBeTruthy();
  });

  test('supports persistent snippets when requested', async () => {
    const { createServer } = await import('../src/start');
    const app = await createServer();
    const html = '<span>keep me</span>';

    const postRes = await request(app)
      .post('/api/html-snippets')
      .send({ html, persist: true })
      .expect(201);

    expect(postRes.body.persistent).toBe(true);
    expect(postRes.body.expiresAt).toBeNull();

    const filePath = path.join(process.env.HTML_SNIPPET_DIR as string, `${postRes.body.id}.json`);
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    parsed.createdAt = Date.now() - 100_000; // very old
    await fs.writeFile(filePath, JSON.stringify(parsed), 'utf8');

    const res = await request(app).get(`/api/html-snippets/${postRes.body.id}`).expect(200);
    expect(res.text).toBe(html);
  });
});
