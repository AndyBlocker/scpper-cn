// src/bootstrap-proxy.js
import { ProxyAgent, setGlobalDispatcher } from 'undici';

export function setupProxy() {
  const proxy = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
  // 全局生效：影响 Node 内置 fetch 以及使用 undici 的库
  setGlobalDispatcher(new ProxyAgent(proxy));
}
