import { ProxyAgent, setGlobalDispatcher } from 'undici';

export function setupProxy(): void {
  const proxy = process.env.SYNCER_HTTP_PROXY || 'http://127.0.0.1:7891';
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log(`[proxy] Global dispatcher set to ${proxy}`);
}
