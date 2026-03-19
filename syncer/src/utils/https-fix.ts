// 拦截全局 fetch，将 http://*.wikidot.com 重写为 https://
// @ukwhatn/wikidot 内部使用 http，但 Wikidot 已强制 HTTPS 重定向
// 必须在创建 Client 之前调用

const originalFetch = globalThis.fetch;

export function applyHttpsFix(): void {
  globalThis.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof input === 'string' && input.startsWith('http://') && input.includes('.wikidot.com')) {
      input = input.replace('http://', 'https://');
    } else if (input instanceof URL && input.protocol === 'http:' && input.hostname.endsWith('.wikidot.com')) {
      input = new URL(input.href.replace('http://', 'https://'));
    } else if (input instanceof Request && input.url.startsWith('http://') && input.url.includes('.wikidot.com')) {
      input = new Request(input.url.replace('http://', 'https://'), input);
    }
    return originalFetch.call(globalThis, input, init);
  } as typeof globalThis.fetch;
}
