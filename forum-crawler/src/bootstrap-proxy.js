// src/bootstrap-proxy.js
import { ProxyAgent, setGlobalDispatcher } from 'undici';

export function setupProxy() {
  const proxy = process.env.FORUM_HTTP_PROXY || 'http://127.0.0.1:7891';
  // 全局生效：影响 Node 内置 fetch 以及使用 undici 的库
  // 默认走 mihomo 7891 负载均衡端口（爬虫 IP 池）
  setGlobalDispatcher(new ProxyAgent(proxy));
}
