// src/auth.js
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LOGIN_URL = 'https://www.wikidot.com/default:login';
const AUTH_STATE_FILE_URL = new URL('../.auth/wikidot.storage.json', import.meta.url);
const AUTH_STATE_PATH = fileURLToPath(AUTH_STATE_FILE_URL);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

export async function refreshAuthState() {
  const username = requireEnv('WIKIDOT_USERNAME');
  const password = requireEnv('WIKIDOT_PASSWORD');
  const proxyServer = process.env.PW_PROXY || 'http://127.0.0.1:7890';

  await fs.mkdir(new URL('../.auth/', import.meta.url), { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    // proxy 可放在 launch（全局）或 newContext（二选一即可）
    proxy: proxyServer ? { server: proxyServer } : undefined,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const context = await browser.newContext();

  // 加速：屏蔽图片/字体/媒体
  await context.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.locator('input[name="login"]').fill(username);
    await page.locator('input[name="password"]').fill(password);

    // 不要盲等 2 秒，尽量等待导航/页面稳定
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      page.click('input[type="submit"], button[type="submit"], a#login-button'),
    ]);

    // 再等一次网络趋于稳定（如果站点不稳定，这里可以放宽到 90s）
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    // 保存 storageState（包含 cookies + localStorage）
    await context.storageState({ path: AUTH_STATE_PATH });

    // 权限收紧：避免 storageState 被其他用户读到（Linux）
    await fs.chmod(AUTH_STATE_PATH, 0o600).catch(() => {});
    console.log(`Saved auth state to ${AUTH_STATE_PATH}`);
  } finally {
    await browser.close();
  }
}
