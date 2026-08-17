import { TextDecoder } from 'node:util';

export interface DetectedImageContent {
  mime: string;
  extension: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/**
 * 只根据响应字节识别可安全保存的图片；URL 扩展名与 Content-Type 都不参与真值判定。
 *
 * 位图格式要求固定签名，且对有廉价容器不变量的格式再检查尺寸/box/chunk 长度。
 * SVG 没有二进制 magic，故只接受 UTF-8、以 svg 为根元素且不含可执行/嵌入能力的子集。
 */
export function sniffImageContent(buffer: Buffer): DetectedImageContent | null {
  if (isPng(buffer)) return { mime: 'image/png', extension: 'png' };
  if (isJpeg(buffer)) return { mime: 'image/jpeg', extension: 'jpg' };
  if (isGif(buffer)) return { mime: 'image/gif', extension: 'gif' };
  if (isWebp(buffer)) return { mime: 'image/webp', extension: 'webp' };
  if (isAvif(buffer)) return { mime: 'image/avif', extension: 'avif' };
  if (isBmp(buffer)) return { mime: 'image/bmp', extension: 'bmp' };
  if (isIco(buffer)) return { mime: 'image/x-icon', extension: 'ico' };
  if (isTiff(buffer)) return { mime: 'image/tiff', extension: 'tiff' };
  if (isSafeSvg(buffer)) return { mime: 'image/svg+xml', extension: 'svg' };
  return null;
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 33
    && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    && buffer.readUInt32BE(8) === 13
    && buffer.subarray(12, 16).toString('ascii') === 'IHDR'
    && buffer.readUInt32BE(16) > 0
    && buffer.readUInt32BE(20) > 0;
}

function isJpeg(buffer: Buffer): boolean {
  if (buffer.length < 11 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    return false;
  }
  // 除 SOI 外还要求一个合法 segment 或 scan marker，避免只用扩展名/3 字节前缀伪装。
  for (let offset = 2; offset + 3 < buffer.length;) {
    if (buffer[offset] !== 0xff) return false;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    const marker = buffer[offset];
    if (marker === undefined) return false;
    if (marker === 0xd9) return true;
    if (marker === 0xda) return offset + 1 < buffer.length;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset++;
      continue;
    }
    if (offset + 2 >= buffer.length) return false;
    const length = buffer.readUInt16BE(offset + 1);
    if (length < 2 || offset + 1 + length > buffer.length) return false;
    offset += 1 + length;
  }
  return false;
}

function isGif(buffer: Buffer): boolean {
  const signature = buffer.subarray(0, 6).toString('ascii');
  return buffer.length >= 13
    && (signature === 'GIF87a' || signature === 'GIF89a')
    && buffer.readUInt16LE(6) > 0
    && buffer.readUInt16LE(8) > 0;
}

function isWebp(buffer: Buffer): boolean {
  if (
    buffer.length < 20
    || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) return false;
  const riffBytes = buffer.readUInt32LE(4) + 8;
  const chunk = buffer.subarray(12, 16).toString('ascii');
  const chunkBytes = buffer.readUInt32LE(16);
  return ['VP8 ', 'VP8L', 'VP8X'].includes(chunk)
    && riffBytes <= buffer.length
    && chunkBytes <= buffer.length - 20;
}

function isAvif(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
  const boxBytes = buffer.readUInt32BE(0);
  if (boxBytes < 16 || boxBytes > buffer.length || (boxBytes - 8) % 4 !== 0) return false;
  const brands: string[] = [];
  for (let offset = 8; offset + 4 <= boxBytes; offset += 4) {
    // offset=12 是 minor_version，不是 brand。
    if (offset !== 12) brands.push(buffer.subarray(offset, offset + 4).toString('ascii'));
  }
  return brands.includes('avif') || brands.includes('avis');
}

function isBmp(buffer: Buffer): boolean {
  if (buffer.length < 26 || buffer.subarray(0, 2).toString('ascii') !== 'BM') return false;
  const declaredBytes = buffer.readUInt32LE(2);
  const dibBytes = buffer.readUInt32LE(14);
  return declaredBytes <= buffer.length && declaredBytes >= 26 && dibBytes >= 12;
}

function isIco(buffer: Buffer): boolean {
  if (buffer.length < 22) return false;
  const count = buffer.readUInt16LE(4);
  return buffer.readUInt16LE(0) === 0
    && buffer.readUInt16LE(2) === 1
    && count > 0
    && 6 + count * 16 <= buffer.length;
}

function isTiff(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const little = buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]));
  const big = buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
  if (!little && !big) return false;
  const firstIfd = little ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  return firstIfd >= 8 && firstIfd < buffer.length;
}

function isSafeSvg(buffer: Buffer): boolean {
  if (buffer.length < 11) return false;
  let text: string;
  try {
    text = UTF8_FATAL.decode(buffer);
  } catch {
    return false;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const withoutProlog = text
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
    .replace(/^\s*<!--[\s\S]*?-->/, '')
    .trim();
  if (!/^<svg(?:\s|>)/i.test(withoutProlog)) return false;
  if (!/(?:<\/svg>\s*|\/>)$/i.test(withoutProlog)) return false;
  // 原样资产可能由浏览器直接渲染；拒绝所有可执行、外链或 HTML 嵌入能力。
  return !/<(?:script|foreignObject|iframe|object|embed|style)\b/i.test(withoutProlog)
    && !/\son[a-z]+\s*=/i.test(withoutProlog)
    && !/(?:javascript:|data:text\/html|@import|url\s*\(|\s(?:href|xlink:href)\s*=)/i.test(withoutProlog);
}

export function contentPrefixHex(buffer: Buffer, bytes = 16): string {
  return buffer.subarray(0, Math.max(0, bytes)).toString('hex');
}
