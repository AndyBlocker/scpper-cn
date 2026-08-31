import type { Request } from 'express';
import { hasInternalKey } from '../src/web/utils/internal-key';

const asReq = (headers: Record<string, string>): Request =>
  ({ get: (name: string) => headers[name.toLowerCase()] } as unknown as Request);

describe('内部密钥豁免', () => {
  const original = process.env.BFF_INTERNAL_API_KEY;
  afterAll(() => { process.env.BFF_INTERNAL_API_KEY = original; });

  test('密钥匹配才放行', () => {
    process.env.BFF_INTERNAL_API_KEY = 'secret-key';
    expect(hasInternalKey(asReq({ 'x-internal-key': 'secret-key' }))).toBe(true);
    expect(hasInternalKey(asReq({ 'x-internal-key': 'wrong' }))).toBe(false);
    expect(hasInternalKey(asReq({}))).toBe(false);
  });

  test('未配置密钥时一律不放行，避免空串互相匹配', () => {
    process.env.BFF_INTERNAL_API_KEY = '';
    expect(hasInternalKey(asReq({ 'x-internal-key': '' }))).toBe(false);
    expect(hasInternalKey(asReq({}))).toBe(false);
  });

  // 回归：前端 Nuxt 把 /api/** 代理到 127.0.0.1:4396，公网请求到 BFF 同样表现为
  // 本机来源，所以豁免绝不能建立在"来源是回环地址"之上（见 router.ts guardInternalRoutes）
  test('豁免不依赖来源 IP', () => {
    process.env.BFF_INTERNAL_API_KEY = 'secret-key';
    const loopbackNoKey = { ...asReq({}), ip: '127.0.0.1' } as unknown as Request;
    expect(hasInternalKey(loopbackNoKey)).toBe(false);
  });
});
