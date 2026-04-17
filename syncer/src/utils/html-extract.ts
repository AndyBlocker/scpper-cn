/**
 * html-extract — 从 Wikidot 页面 HTML 中提取结构化数据
 */

/**
 * 从 Wikidot 页面 HTML 中提取 wikidotId
 * HTML 中嵌入了 WIKIREQUEST.info.pageId = <number>;
 */
export function extractWikidotId(html: string): number | null {
  const match = html.match(/WIKIREQUEST\.info\.pageId\s*=\s*(\d+)\s*;/);
  if (!match?.[1]) return null;
  const id = parseInt(match[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * 从 HTML 中提取纯文本内容（用于全文搜索）
 * 目标：与 v1 的 textContent 字段对齐
 */
export function extractTextContent(html: string): string {
  // 移除 script / style / noscript 标签及其内容
  let text = html.replace(/<(script|style|noscript|head)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // 提取 page-content 区域：从 id="page-content" 开始，到下一个同级标记结束
  // 用 indexOf 而非 regex 来避免嵌套 </div> 问题
  const contentStart = text.indexOf('id="page-content"');
  if (contentStart !== -1) {
    // 找到 page-content 开始标签的 >
    const tagEnd = text.indexOf('>', contentStart);
    if (tagEnd !== -1) {
      // 找到 page-options 或 page-tags 或 footer 的位置作为结束
      const endMarkers = ['id="page-options', 'class="page-tags', 'id="page-info', 'class="page-options-bottom'];
      let endPos = text.length;
      for (const marker of endMarkers) {
        const pos = text.indexOf(marker, tagEnd);
        if (pos !== -1 && pos < endPos) endPos = pos;
      }
      text = text.substring(tagEnd + 1, endPos);
    }
  }

  // 移除 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ');

  // 解码常见 HTML 实体
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ');

  // 压缩空白
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * 从 wiki source 提取纯文本（更简洁的方案）
 * 移除 wiki 标记，保留可搜索的文本
 */
export function extractTextFromSource(source: string): string {
  let text = source;

  // 移除 [[module]] / [[include]] 块
  text = text.replace(/\[\[module\s+[\s\S]*?\]\]/gi, '');
  text = text.replace(/\[\[include\s+[^\]]*\]\]/gi, '');

  // 移除 [[div]] / [[span]] 等格式标签（保留内容）
  text = text.replace(/\[\[\/?(div|span|collapsible|tabview|tab|footnote|note|image|=image|size|css|html|iframe|embed|toc|f<|f>)[^\]]*\]\]/gi, '');

  // 移除链接标记，保留显示文本
  text = text.replace(/\[\[\[([^\]|]+)\|([^\]]+)\]\]\]/g, '$2');  // [[[url|text]]]
  text = text.replace(/\[\[\[([^\]]+)\]\]\]/g, '$1');              // [[[text]]]
  text = text.replace(/\[([^\s\]]+)\s+([^\]]+)\]/g, '$2');         // [url text]

  // 移除格式标记
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');   // bold
  text = text.replace(/\/\/(.+?)\/\//g, '$1');    // italic
  text = text.replace(/__(.+?)__/g, '$1');         // underline
  text = text.replace(/--(.+?)--/g, '$1');         // strikethrough
  text = text.replace(/\^\^(.+?)\^\^/g, '$1');     // superscript
  text = text.replace(/,,(.+?),,/g, '$1');         // subscript

  // 移除标题标记
  text = text.replace(/^\++\s*/gm, '');

  // 移除水平线
  text = text.replace(/^----+$/gm, '');

  // 压缩空白
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * 批量从 fullPageHtml 中提取 wikidotId
 * 返回 fullname → wikidotId 映射
 */
export function extractWikidotIds(
  pages: Map<string, string>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [fullname, html] of pages) {
    const id = extractWikidotId(html);
    if (id != null) {
      result.set(fullname, id);
    }
  }
  return result;
}
