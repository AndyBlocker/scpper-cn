import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetch, setGlobalDispatcher, ProxyAgent } from 'undici';
import { CookieJar } from 'tough-cookie';
import { load } from 'cheerio';

const LOGIN_URL = 'https://www.wikidot.com/default--flow/login__LoginPopupScreen'; // 新地址 :contentReference[oaicite:3]{index=3}
const COOKIE_FILE_URL = new URL('../.auth/wikidot.cookies.json', import.meta.url);
const COOKIE_FILE = fileURLToPath(COOKIE_FILE_URL);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

async function main() {
  const username = requireEnv('WIKIDOT_USERNAME');
  const password = requireEnv('WIKIDOT_PASSWORD');

  const proxy = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
  setGlobalDispatcher(new ProxyAgent(proxy));

  await fs.mkdir(new URL('../.auth/', import.meta.url), { recursive: true });

  const jar = new CookieJar();

  // 1) GET 登录页
  const res1 = await fetch(LOGIN_URL, {
    headers: { 'User-Agent': 'SCPper-Forum-Crawler/0.1' },
  });
  const html1 = await res1.text();
  for (const sc of (res1.headers.getSetCookie?.() ?? [])) {
    await jar.setCookie(sc, LOGIN_URL);
  }
  if (!res1.ok) throw new Error(`GET login page failed: ${res1.status}`);

  // 2) 解析 form（含 hidden fields + action）
  const $ = load(html1);
  const form =
    $('form').has('input[name="login"]').has('input[name="password"]').first();

  if (!form.length) {
    throw new Error(
      'Login form not found in HTML. Wikidot login may be JS/AJAX-driven; use Playwright once as fallback.'
    );
  }

  const action = form.attr('action') || LOGIN_URL;
  const actionUrl = new URL(action, LOGIN_URL).toString();
  const method = (form.attr('method') || 'POST').toUpperCase();

  const params = new URLSearchParams();
  form.find('input[name]').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    const type = ($(el).attr('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if ($(el).attr('checked')) params.set(name, $(el).attr('value') ?? 'on');
      return;
    }
    params.set(name, $(el).attr('value') ?? '');
  });

  // 覆盖账号密码
  params.set('login', username);
  params.set('password', password);

  // 3) POST 提交
  const cookieHeader = await jar.getCookieString(actionUrl);
  const res2 = await fetch(actionUrl, {
    method,
    headers: {
      'User-Agent': 'SCPper-Forum-Crawler/0.1',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader,
      'Referer': LOGIN_URL,
      'Origin': 'https://www.wikidot.com',
    },
    body: params,
    redirect: 'follow',
  });

  const html2 = await res2.text();
  for (const sc of (res2.headers.getSetCookie?.() ?? [])) {
    await jar.setCookie(sc, actionUrl);
  }

  // 4) 粗略判断是否登录失败
  if (html2.includes('default--flow/login') && html2.includes('name="login"')) {
    throw new Error('Login likely failed (still seeing login screen).');
  }

  await fs.writeFile(COOKIE_FILE, JSON.stringify(jar.toJSON(), null, 2), 'utf-8');
  await fs.chmod(COOKIE_FILE, 0o600).catch(() => {});
  console.log(`Saved cookies to ${COOKIE_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
