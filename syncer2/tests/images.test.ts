process.env.SYNCER2_LOG_LEVEL = 'error';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractImagesFromHtml,
  extractImagesFromWikidotSource,
  extractPageImages,
  imageCandidateToJson,
  normalizeImageUrl,
} from '../src/content/extractImages.js';

const pageUrl = 'https://scp-wiki-cn.wikidot.com/Some:Page';
const slug = 'some:page';

describe('图片 HTML 提取：只读 page-content、lazy fallback、同次响应去重', () => {
  it('忽略正文外头像与 script 字符串，保留无扩展名 img', () => {
    const html = `
      <img src="https://avatar.example/u.png">
      <div id="page-content">
        <script>const sample = '<img src="https://bad.example/a.png">';</script>
        <img src="https://www.wikidot.com/avatar.php?userid=1">
        <img src="http://scp-wiki-cn.wikidot.com/local--files/Foo/A.PNG?cache=1#x">
        <img src="data:image/gif;base64,AA" data-src="//img.example.com/render?id=7">
        <img src="/local--resized-images/Foo/{$image-url}/medium.jpg">
      </div>
      <img src="https://footer.example/logo.png">
    `;
    const images = extractImagesFromHtml(html, pageUrl, slug);
    assert.equal(images.length, 2);
    assert.deepEqual(
      images.map((image) => image.normalizedUrl).sort(),
      [
        'https://img.example.com/render',
        'https://scp-wiki-cn.wdfiles.com/local--files/foo/a.png',
      ],
    );
    assert.equal(
      images.find((image) => image.normalizedUrl.includes('img.example'))?.displayUrl,
      'https://img.example.com/render?id=7',
    );
  });

  it('截断或缺 page-content 时不退回整篇文档', () => {
    assert.deepEqual(
      extractImagesFromHtml('<img src="https://x/a.png">', pageUrl, slug),
      [],
    );
    assert.deepEqual(
      extractImagesFromHtml(
        '<div id="page-content"><img src="https://x/a.png">',
        pageUrl,
        slug,
      ),
      [],
    );
  });
});

describe('Wikidot 源码图片：[[image]] 相对附件/local--files/image-block', () => {
  it('解析相对文件名与常用 image-block，不把属性吞进 URL', () => {
    const source = `
      [[image 本页 图片.PNG width="200px" alt="x"]]
      [[=image /local--files/Some:Page/Second.JPG?download=1]]
      [[include component:image-block name=http://scp-wiki.wdfiles.com/local--files/X/A.jpg|caption=图]]
      [[image http://scp-wiki.wdfiles.com/local--files/X/B.jpg 属性1="数值1"]]
      [[image http://scp-wiki.wdfiles.com/local--resized-images/X/C.jpg "iwidth:100%;"]]
      [[include component:image-block name=##**|caption=模板标记]]
      [[image :first]]
      [[image {$profile-pic}]]
    `;
    const images = extractImagesFromWikidotSource(source, pageUrl, slug);
    assert.deepEqual(
      images.map((image) => image.normalizedUrl).sort(),
      [
        'https://scp-wiki-cn.wdfiles.com/local--files/some:page/%e6%9c%ac%e9%a1%b5%20%e5%9b%be%e7%89%87.png',
        'https://scp-wiki-cn.wdfiles.com/local--files/some:page/second.jpg',
        'https://scp-wiki.wdfiles.com/local--files/x/a.jpg',
        'https://scp-wiki.wdfiles.com/local--files/x/b.jpg',
        'https://scp-wiki.wdfiles.com/local--resized-images/x/c.jpg',
      ],
    );
    assert.ok(images.every((image) => !image.displayUrl.includes('|caption=')));
    assert.ok(images.every((image) => !image.displayUrl.includes('%20%22iwidth')));
  });

  it('注释、CSS/code 与 @@ 示例不会入队', () => {
    const source = `
      [!-- [[image hidden.png]] --]
      [[module CSS]].x{content:"[[image css.png]]"}[[/module]]
      [[code]][[image code.png]][[/code]]
      @@[[image escaped.png]]@@
      [[image real.png]]
    `;
    const images = extractImagesFromWikidotSource(source, pageUrl, slug);
    assert.equal(images.length, 1);
    assert.match(images[0]!.displayUrl, /real\.png$/);
  });

  it('提取合法裸图片 URL，但排除 local--files 下的 PDF/视频与代码示例', () => {
    const source = `
      图片来源：https://img.example.com/A.JPEG?source=1
      [[include component:hero src=http://scp-wiki.wdfiles.com/local--files/x/no-extension|x=1]]
      http://scp-wiki.wdfiles.com/local--files/x/manual.pdf
      http://scp-wiki.wdfiles.com/local--files/x/demo.mp4
      [[code]]https://img.example.com/example.png[[/code]]
    `;
    const images = extractImagesFromWikidotSource(source, pageUrl, slug);
    assert.deepEqual(
      images.map((image) => image.normalizedUrl).sort(),
      [
        'https://img.example.com/a.jpeg',
        'https://scp-wiki.wdfiles.com/local--files/x/no-extension',
      ],
    );
  });
});

describe('图片 URL 归一化与跨信源合并', () => {
  it('协议/主机/大小写/query/wdfiles 等价形式收敛，display 保留抓取 query', () => {
    const normalized = normalizeImageUrl(
      'HTTP://SCP-WIKI-CN.WIKIDOT.COM:80/local--files/Foo/Bar.PNG?v=2#hero',
      { pageUrl, slug, source: 'wikidot_image' },
    );
    assert.deepEqual(normalized, {
      displayUrl: 'https://scp-wiki-cn.wdfiles.com/local--files/Foo/Bar.PNG?v=2',
      normalizedUrl: 'https://scp-wiki-cn.wdfiles.com/local--files/foo/bar.png',
    });
  });

  it('wdfiles 分类冒号、编码斜杠与重复斜杠归为同一键', () => {
    const variants = [
      'http://scp-wiki-cn.wikidot.com//local--files/collab%3Asite/a%2Fb.PNG',
      'https://scp-wiki-cn.wdfiles.com/local--files/collab:site/a/b.png?x=1',
    ].map((raw) =>
      normalizeImageUrl(raw, { pageUrl, slug, source: 'wikidot_image' })?.normalizedUrl,
    );
    assert.deepEqual(variants, [
      'https://scp-wiki-cn.wdfiles.com/local--files/collab:site/a/b.png',
      'https://scp-wiki-cn.wdfiles.com/local--files/collab:site/a/b.png',
    ]);
  });

  it('HTML 优先作为 displayUrl，metadata 同时留两个来源', () => {
    const images = extractPageImages({
      pageUrl,
      slug,
      html:
        '<div id="page-content">' +
        '<img src="https://scp-wiki-cn.wdfiles.com/local--files/some:page/A.PNG?fresh=1">' +
        '</div>',
      source: '[[image A.PNG]]',
    });
    assert.equal(images.length, 1);
    assert.equal(
      images[0]!.displayUrl,
      'https://scp-wiki-cn.wdfiles.com/local--files/some:page/A.PNG?fresh=1',
    );
    assert.deepEqual(images[0]!.sources, ['html_img', 'wikidot_image']);
    assert.deepEqual(imageCandidateToJson(images[0]!).metadata, {
      extraction_version: 2,
      sources: ['html_img', 'wikidot_image'],
    });
  });
});
