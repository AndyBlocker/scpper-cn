import {
  isAllowedUrl,
  isAlreadyProxyRef,
  rewriteAssetRef,
  rewriteCssUrls,
} from '../src/web/utils/asset-proxy';

const BASE = new URL('https://scp-wiki-cn.wikidot.com/');
const P = 'https://scpper.example/api/css-proxy';

describe('asset-proxy', () => {
  test('只代理 wikidot 生态内的域名', () => {
    expect(isAllowedUrl('https://scp-wiki.wdfiles.com/local--files/x/a.png')).toBe(true);
    expect(isAllowedUrl('https://d3g0gp89917ko0.cloudfront.net/x.css')).toBe(true);
    expect(isAllowedUrl('https://i.imgur.com/a.png')).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
    // 后缀匹配不能被 evil-wikidot.com.attacker.net 之类蒙混过去
    expect(isAllowedUrl('https://wikidot.com.attacker.net/a.png')).toBe(false);
  });

  test('http:// 明文引用被吸收进代理，顺带消除混合内容', () => {
    const out = rewriteAssetRef('http://scp-wiki.wdfiles.com/local--files/x/a.png', BASE, P);
    expect(out).toBe(`${P}?url=${encodeURIComponent('http://scp-wiki.wdfiles.com/local--files/x/a.png')}`);
  });

  test('相对路径按 <base> 解析后再代理', () => {
    expect(rewriteAssetRef('/local--files/x/a.png', BASE, P))
      .toContain(encodeURIComponent('https://scp-wiki-cn.wikidot.com/local--files/x/a.png'));
  });

  test('白名单外的域只绝对化、不代理', () => {
    expect(rewriteAssetRef('https://i.imgur.com/a.png', BASE, P)).toBe('https://i.imgur.com/a.png');
  });

  test('data: 与 var() 原样放行', () => {
    expect(rewriteAssetRef('data:image/png;base64,AAA', BASE, P)).toBe('data:image/png;base64,AAA');
    expect(rewriteAssetRef('var(--bg)', BASE, P)).toBe('var(--bg)');
  });

  test('改写是幂等的，不会套娃', () => {
    const css = 'body{background:url(https://scp-wiki.wdfiles.com/local--files/x/a.png)}';
    const once = rewriteCssUrls(css, BASE, P);
    const twice = rewriteCssUrls(once, BASE, P);
    expect(twice).toBe(once);
    expect(isAlreadyProxyRef(`${P}?url=x`)).toBe(true);
    expect(once.match(/css-proxy/g)).toHaveLength(1);
  });

  test('@import 与 url() 都会被改写', () => {
    const css = [
      '@import url("https://sigma9.scpwikicn.com/a.css");',
      '.x{background-image:url(\'https://scp-wiki-cn.wdfiles.com/local--files/y/b.jpg\')}',
    ].join('\n');
    const out = rewriteCssUrls(css, BASE, P);
    expect(out.match(/css-proxy\?url=/g)).toHaveLength(2);
  });
});
