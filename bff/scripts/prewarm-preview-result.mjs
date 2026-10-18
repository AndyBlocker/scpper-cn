/** 分类预热结果；头像缓存由 avatar-agent 管理，其他资源仍以代理磁盘缓存为准。 */
export function classifyPrewarmResponse(response, { diskCached = false, wasCached = false } = {}) {
  if (!response.ok) return 'failed';

  const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const avatarSource = response.headers.get('x-avatar-source');
  const isImage = /^image\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType);
  if (isImage && (avatarSource === 'local' || avatarSource === 'stale')) return 'avatar-warmed';
  if (isImage && avatarSource === 'default') return 'avatar-fallback';

  // CSS 会用 200 注释软失败，响应成功与头像 header 都不能代替真实落盘证据。
  if (diskCached) return wasCached ? 'hit' : 'warmed';
  return 'failed';
}

/** 保持“存在新抓成功则允许部分失败”的退出约定，同时识别独立头像缓存。 */
export function shouldFailPrewarm({ warmed = 0, avatarWarmed = 0, failed = 0, avatarFallback = 0 }) {
  return warmed === 0 && avatarWarmed === 0 && (failed > 0 || avatarFallback > 0);
}
