#!/usr/bin/env node

/**
 * Inspect an FTML html-snippet iframe target and explain why it may look wrong.
 *
 * Usage:
 *   node scripts/inspect-iframe-snippet.mjs \
 *     --iframe-url 'https://scpper.mer.run/api/html-snippet/<id>' \
 *     [--page-url 'https://scp-wiki-cn.wikidot.com/scp-cn-2317-j']
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function printHelpAndExit(code = 0) {
  const lines = [
    'Usage:',
    '  node scripts/inspect-iframe-snippet.mjs --iframe-url <url> [--page-url <url>]',
    '',
    'Options:',
    '  --iframe-url   Required. The suspicious iframe src.',
    '  --page-url     Optional. Page URL for additional context lookup.',
    '  -h, --help     Show this help.',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    iframeUrl: '',
    pageUrl: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printHelpAndExit(0);
    }
    if (arg === '--iframe-url') {
      out.iframeUrl = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg === '--page-url') {
      out.pageUrl = argv[i + 1] || '';
      i += 1;
      continue;
    }
  }

  if (!out.iframeUrl) {
    process.stderr.write('Missing --iframe-url\n');
    printHelpAndExit(1);
  }

  return out;
}

function normalizeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    const key = String(m[1] || '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = String(value);
  }
  return attrs;
}

function extractIframeTags(html) {
  const text = String(html || '');
  const tags = [];
  const re = /<iframe\b[^>]*>/gi;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[0];
    const attrs = parseAttrs(tag);
    tags.push({
      raw: tag,
      src: normalizeUrl(attrs.src || ''),
      style: String(attrs.style || ''),
      sandbox: String(attrs.sandbox || ''),
      attrs,
    });
  }
  return tags;
}

function styleContainsDisplayNone(style) {
  return /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(
    String(style || ''),
  );
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,*/*;q=0.1',
      'User-Agent': 'scpper-snippet-inspector/1.0',
    },
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    contentType: String(response.headers.get('content-type') || ''),
    text,
  };
}

function classifyInnerIframes(iframes) {
  const hiddenStyleFrames = iframes.filter((frame) => {
    return (
      /interwiki\.scpwikicn\.com\/styleframe\.html/i.test(frame.src) &&
      styleContainsDisplayNone(frame.style)
    );
  });

  const unresolvedTemplateVars = iframes.filter((frame) => /\{\$[a-z0-9_-]+\}/i.test(frame.src));

  const helperOnly =
    iframes.length > 0 &&
    hiddenStyleFrames.length === iframes.length;

  return {
    helperOnly,
    hiddenStyleFrameCount: hiddenStyleFrames.length,
    unresolvedTemplateVars,
    hiddenStyleFrames,
  };
}

function isHtmlSnippetPath(url) {
  try {
    const parsed = new URL(url);
    return /\/(?:api\/)?html-snippets?(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function resolveInterwikiThemeToCssUrl(rawTheme) {
  const value = normalizeUrl(rawTheme);
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const match = String(parsed.pathname || '').match(/^\/(theme:[^/?#]+)$/i);
    if (!match) return parsed.toString();
    parsed.pathname = `/local--code/${encodeURIComponent(match[1])}/1`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

function extractThemeFromStyleFrameSrc(src) {
  const value = normalizeUrl(src);
  if (!value) return '';
  try {
    const parsed = new URL(value, 'https://scpper.mer.run');
    if (!/styleframe\.html/i.test(parsed.pathname)) return '';
    const rawTheme = String(parsed.searchParams.get('theme') || '').trim();
    if (!rawTheme) return '';
    return normalizeUrl(rawTheme);
  } catch {
    return '';
  }
}

function toProxyUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return `https://scpper.mer.run/api/css-proxy?url=${encodeURIComponent(value)}`;
}

async function inspectLocalRenderer() {
  const filePath = '/home/andyblocker/ftml/src/render/html/element/iframe.rs';
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const hasRenderHtml = /pub\s+fn\s+render_html\s*\(/.test(content);
    const renderHtmlBlock = content.match(
      /pub\s+fn\s+render_html[\s\S]*?ctx\.html\(\)\.iframe\(\)\.attr\(\s*attr!\(([\s\S]*?)\)\s*\);/,
    );
    const attrBlock = renderHtmlBlock ? renderHtmlBlock[1] : '';
    const hasStyleAttr = /"style"\s*=>/.test(attrBlock);
    return {
      ok: true,
      filePath,
      hasRenderHtml,
      hasStyleAttr,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error),
      filePath,
    };
  }
}

function summarizeReason({
  iframeUrl,
  snippetInfo,
  innerIframes,
  classify,
  rendererInfo,
  cssProbeResults,
}) {
  const lines = [];
  lines.push('=== Snippet Iframe Inspection ===');
  lines.push(`iframe-url: ${iframeUrl}`);
  lines.push(`fetched-url: ${snippetInfo.url}`);
  lines.push(`status: ${snippetInfo.status}`);
  lines.push(`content-type: ${snippetInfo.contentType || '(empty)'}`);
  lines.push(`inner-iframe-count: ${innerIframes.length}`);
  lines.push(
    `hidden-interwiki-styleframe-count: ${classify.hiddenStyleFrameCount}`,
  );
  lines.push(
    `snippet-helper-only: ${classify.helperOnly ? 'yes' : 'no'}`,
  );
  lines.push('');

  if (innerIframes.length > 0) {
    lines.push('inner-iframes:');
    innerIframes.forEach((frame, idx) => {
      lines.push(`  [${idx + 1}] src=${frame.src}`);
      lines.push(`      style=${frame.style || '(none)'}`);
      if (frame.sandbox) lines.push(`      sandbox=${frame.sandbox}`);
    });
    lines.push('');
  }

  if (classify.unresolvedTemplateVars.length > 0) {
    lines.push('warning: unresolved template variables found in iframe src:');
    classify.unresolvedTemplateVars.forEach((frame) => {
      lines.push(`  - ${frame.src}`);
    });
    lines.push('');
  }

  if (cssProbeResults.length > 0) {
    lines.push('style-injection-probe:');
    cssProbeResults.forEach((item, idx) => {
      lines.push(`  [${idx + 1}] styleframe-src=${item.styleFrameSrc}`);
      lines.push(`      raw-theme=${item.rawTheme || '(none)'}`);
      lines.push(`      resolved-theme=${item.resolvedTheme || '(none)'}`);
      lines.push(`      proxy-url=${item.proxyUrl || '(none)'}`);
      lines.push(
        `      proxy-status=${item.status} content-type=${item.contentType || '(empty)'}`,
      );
      lines.push(`      css-effective=${item.cssEffective ? 'yes' : 'no'}`);
    });
    lines.push('');
  }

  lines.push('analysis:');
  if (isHtmlSnippetPath(iframeUrl) && classify.helperOnly) {
    lines.push(
      '  - This html-snippet contains only hidden interwiki styleFrame helper iframe(s).',
    );
    lines.push(
      '  - Expected behavior: helper is used only to inject styles and should not be visibly rendered.',
    );
  } else {
    lines.push(
      '  - This snippet is not a pure hidden style helper; visible rendering may be expected.',
    );
  }

  if (rendererInfo.ok && rendererInfo.hasRenderHtml) {
    lines.push(
      `  - Renderer source: ${rendererInfo.filePath}`,
    );
    if (!rendererInfo.hasStyleAttr) {
      lines.push(
        '  - FTML [[html]] wrapper iframe is emitted without style=display:none; outer iframe can stay visible even when inner content is hidden.',
      );
    } else {
      lines.push(
        '  - Renderer includes style attr for [[html]] wrapper iframe.',
      );
    }
  } else if (!rendererInfo.ok) {
    lines.push(
      `  - Could not inspect local renderer source: ${rendererInfo.error}`,
    );
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const iframeUrl = normalizeUrl(args.iframeUrl);
  const pageUrl = normalizeUrl(args.pageUrl);

  const snippetInfo = await fetchText(iframeUrl);
  const innerIframes = extractIframeTags(snippetInfo.text);
  const classify = classifyInnerIframes(innerIframes);
  const rendererInfo = await inspectLocalRenderer();
  const cssProbeResults = [];

  for (const frame of classify.hiddenStyleFrames) {
    const rawTheme = extractThemeFromStyleFrameSrc(frame.src);
    const resolvedTheme = resolveInterwikiThemeToCssUrl(rawTheme);
    const proxyUrl = toProxyUrl(resolvedTheme);
    if (!proxyUrl) continue;
    try {
      const probe = await fetchText(proxyUrl);
      cssProbeResults.push({
        styleFrameSrc: frame.src,
        rawTheme,
        resolvedTheme,
        proxyUrl,
        status: probe.status,
        contentType: probe.contentType,
        cssEffective: /text\/css/i.test(probe.contentType || '') && probe.status >= 200 && probe.status < 300,
      });
    } catch (error) {
      cssProbeResults.push({
        styleFrameSrc: frame.src,
        rawTheme,
        resolvedTheme,
        proxyUrl,
        status: 0,
        contentType: '',
        cssEffective: false,
        error: String(error),
      });
    }
  }

  const report = summarizeReason({
    iframeUrl,
    snippetInfo,
    innerIframes,
    classify,
    rendererInfo,
    cssProbeResults,
  });
  process.stdout.write(report + '\n');

  if (pageUrl) {
    try {
      const pageInfo = await fetchText(pageUrl);
      const hasText = pageInfo.text.includes('下面的这一点控制着标志与次级标题的修改');
      const hasStyleFrame = pageInfo.text.includes('interwiki.scpwikicn.com/styleFrame.html');
      const extra = [
        '',
        'page-context:',
        `  page-url: ${pageInfo.url}`,
        `  page-status: ${pageInfo.status}`,
        `  page-has-target-text: ${hasText ? 'yes' : 'no'}`,
        `  page-has-styleFrame: ${hasStyleFrame ? 'yes' : 'no'}`,
      ];
      process.stdout.write(extra.join('\n') + '\n');
    } catch (error) {
      process.stdout.write(
        `\npage-context:\n  failed-to-fetch-page: ${String(error)}\n`,
      );
    }
  }
}

main().catch((error) => {
  process.stderr.write(`inspect failed: ${String(error)}\n`);
  process.exit(1);
});
