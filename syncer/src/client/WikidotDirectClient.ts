import { Client, type Site } from '@ukwhatn/wikidot';
import { applyHttpsFix } from '../utils/https-fix.js';
import { setupProxy } from '../utils/proxy.js';

let client: Client | null = null;
let site: Site | null = null;

export async function connect(siteName?: string): Promise<Site> {
  applyHttpsFix();
  setupProxy();

  const name = siteName || process.env.SYNCER_SITE_NAME || 'scp-wiki-cn';

  // createAnonymous 直接返回 Client（非 Result）
  client = Client.createAnonymous();

  const siteRes = await client.site.get(name);
  if (!siteRes.isOk()) throw siteRes.error;
  site = siteRes.value;

  console.log(`[wikidot] Connected to site: ${name}`);
  return site;
}

export function getSite(): Site {
  if (!site) throw new Error('WikidotDirectClient not connected. Call connect() first.');
  return site;
}

export async function close(): Promise<void> {
  if (client) {
    try {
      const res = await client.close();
      if (!res.isOk()) console.warn('[wikidot] client.close failed:', res.error);
    } catch (err) {
      console.warn('[wikidot] client.close threw:', err);
    }
    client = null;
    site = null;
  }
}
