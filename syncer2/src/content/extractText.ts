/**
 * extractTextContent —— 从 wikidot 整页 HTML 提取正文纯文本。
 *
 * 这是 v2 里 `ingest.content_blob.text_content` 的唯一生产者，也就是
 * **quotes / snippet / 语义检索 embedding 的共同输入**（见 0001_ingest.sql 对该列的注释）。
 * v1 时代这列是 CROM 给的 `PageVersion.textContent`；v2 直连 wikidot 后没有上游帮我们渲染，
 * 必须自己从 `#page-content` 提取。
 *
 * ── 为什么零依赖手写扫描器，不用 cheerio ────────────────────────────────────
 * node_modules 里确实有 cheerio，但它是 `@ukwhatn/wikidot` 的**传递依赖**，
 * 没有写进本包 package.json。把摄入热路径压在一个未声明的传递依赖上，
 * 等于给"某天上游换 HTML 解析器"埋一颗静默炸弹。我们需要的能力只有四项：
 *   (1) 定位 `#page-content` 子树  (2) 按 class/id 剪掉若干区域
 *   (3) 块级元素边界转换行        (4) 实体解码
 * 都不需要真正的 DOM。手写扫描器 ~300 行、可测、无依赖、单遍 O(n)。
 *
 * ── CROM 提取规则的实测反推（2026-07-27，100 页样本）────────────────────────
 * 对齐 CROM 时先搞清它到底提取了什么。逐结构统计"HTML 里有该结构的页数 / 其中
 * v1 textContent 含该结构文字的页数"：
 *   · `.page-rate-widget-box`（"评分: +2655"）  58 页 → 2 页   ⇒ **CROM 剪掉**
 *   · `.licensebox`（授权声明）                19 页 → 5 页   ⇒ **CROM 剪掉**
 *   · `#breadcrumbs`                           17 页 → 1 页   ⇒ 本就在 page-content 外
 *   · `.footnotes-footer`（脚注区）            46 页 → 32 页  ⇒ **CROM 保留**
 *   · `#u-credit-view`（"著作信息"模态框）     22 页 → 21 页  ⇒ **CROM 保留**（含隐藏内容）
 * 另外 CROM 的输出**不折叠源码缩进空白**：实测 pv=27005 的 textContent 开头是
 * `'著作信息\n\n\n\n\n\n    \n        \n        \n'` —— 那是 HTML 源码里的缩进被原样搬了过来。
 * 所以 CROM 的 textContent 有相当比例是"HTML 排版噪声"，不是内容。
 *
 * ── 本实现刻意偏离 CROM 的两处（都写在 docs/embedding-migration.md 里）───────
 * D-A. **折叠空白**：文本节点内 `\s+` → 单空格，块级边界产生换行，行尾空白剪掉，
 *      连续空行压到最多一个。理由：那些缩进空白对 embedding 与 quotes 都是纯噪声，
 *      且会占掉定长分块窗口的额度（实测 CROM 文本里最多有连续 6 个纯空白行）。
 *      代价：与 v1 textContent 逐字符比较必然大面积不等 —— 这正是 embedding
 *      是否重算这道决策的由来，不是 bug。
 * D-B. **折叠块（collapsible）的两个标签都保留**，与 CROM 一致：wikidot 把
 *      folded/unfolded 两份 DOM 都渲染出来，所以"+ 标题"和"- 标题"会各出现一次。
 *      刻意不做去重 —— 去重需要认定 `.collapsible-block-folded` 是"UI 而非内容"，
 *      而中心页/tab 页大量把有意义的正文放在 folded 里，误剪的代价远大于重复。
 *
 * ── 已知未覆盖 ──────────────────────────────────────────────────────────────
 *   · `<iframe>` 里的内容（credit 模块正文、投票器）—— 跨文档，CROM 也没有。
 *   · JS 运行时才注入的内容（ListPages module 已由服务端渲染，不受影响；
 *     但 `scpper_mer_run` 之类前端脚本产出的文本拿不到）。
 *   · 图片 alt / title 属性：默认不取（CROM 也不取）。
 */

// ─── 常量：标签分类 ──────────────────────────────────────────────────────────

/** 整棵子树丢弃的标签（内容不是正文）。 */
const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'math',
  'head',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
]);

/** HTML void 元素：不入栈，没有闭合标签。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'basefont',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'isindex',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** 块级元素：进入/离开时产生换行边界。 */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'legend',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
]);

/**
 * 按 class 丢弃的区域。实测反推 CROM 也剪这两类（见文件头）。
 * 匹配语义：元素的 class 列表**包含**该词（不是子串匹配）。
 */
const DROP_CLASSES = new Set([
  'page-rate-widget-box', // "评分: +2655 + – x"
  'licensebox', // 页脚授权声明
  // 系列导航条 "« SCP-3683 | SCP-3684 | SCP-3685 »"。实测 48/100 页有该结构，
  // 而 v1 textContent 里只有 2 页出现 «/» ⇒ CROM 剪掉它。它是导航而不是正文。
  'footer-wikiwalk-nav',
  // wikidot [[code]] 块（渲染成 <div class="code"><pre>…）。实测 8/100 页有，
  // 块内文本出现在 v1 textContent 的 0/8 ⇒ CROM 剪掉。这也符合 embedding 的利益：
  // 主题 CSS / JS 源码几百上千字符，是纯噪声，还会挤占定长分块窗口。
  // 已知风险:'code' 是很泛的 class 词元，理论上可能误伤第三方组件；实测样本无误伤。
  'code',
  'creditButton', // 著作信息的那个 (i) 图标按钮
  'modalcontainer-close', // 模态框的 X
]);

/** 按 id 丢弃的区域。 */
const DROP_IDS = new Set([
  'breadcrumbs', // 正常在 page-content 外，防个别皮肤把它塞进来
  'action-area', // wikidot 编辑工具条
  'page-info-break',
]);

// ─── 结果类型 ────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** 额外丢弃的 class（并入默认表）。 */
  extraDropClasses?: readonly string[];
  /** 额外丢弃的 id。 */
  extraDropIds?: readonly string[];
  /**
   * 找不到 `#page-content` 时是否退回整个 `#main-content` / 整篇文档。
   * 默认 false —— 宁可返回 null 让调用方进 quarantine，也不要把导航栏当正文喂进 embedding。
   */
  fallbackToBody?: boolean;
}

export interface ExtractResult {
  /** 归一化后的正文。`containerFound=false` 且未开 fallback 时为空串。 */
  text: string;
  /** 是否定位到了 `#page-content`。 */
  containerFound: boolean;
  /** 实际使用的容器（'page-content' | 'main-content' | 'document'）。 */
  container: 'page-content' | 'main-content' | 'document' | 'none';
  /** 被丢弃的子树数量（按 DROP_TAGS/DROP_CLASSES/DROP_IDS 命中计）。 */
  droppedSubtrees: number;
  /** 结构异常留痕；非空即应写 meta 侧的解析健康计数器。 */
  warnings: string[];
}

// ─── 实体解码 ────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  dagger: '†',
  Dagger: '‡',
  times: '×',
  divide: '÷',
  plusmn: '±',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  sect: '§',
  para: '¶',
  permil: '‰',
  prime: '′',
  Prime: '″',
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  infin: '∞',
  ne: '≠',
  le: '≤',
  ge: '≥',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  omega: 'ω',
  Omega: 'Ω',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  shy: '­',
  frac12: '½',
  frac14: '¼',
  sup2: '²',
  sup3: '³',
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/**
 * 解码 HTML 实体。刻意只认**带分号**的形式：wikidot 正文里 `&` 后跟字母的裸文本
 * （如 "Foo &amp Bar" 手写错误、或 "R&D"）不该被误解码。
 * 未识别的命名实体原样保留 —— 保留比猜错好，留痕交给上层统计。
 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // 代理区码位非法，原样保留。
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const mapped = NAMED_ENTITIES[body];
    return mapped ?? whole;
  });
}

// ─── 归一化 ──────────────────────────────────────────────────────────────────

/**
 * 我方正文的规范形式。**幂等**（norm(norm(x)) === norm(x)），这一点被测试断言。
 *
 * 规则：
 *   1. NBSP / 各种不换行空格 → 普通空格；`\r\n`、`\r` → `\n`；剥掉 BOM 与零宽字符。
 *   2. 行内空白（空格/制表）压成单个空格。
 *   3. 每行两端 trim。
 *   4. 连续空行压到**一个**空行（段落分隔），不是全删 —— 段落结构对分块有意义。
 *   5. 首尾 trim。
 */
export function normalizeExtracted(s: string): string {
  let t = s
    .replace(/^﻿/, '')
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[  -   　]/g, ' ');
  t = t.replace(/[ \t]+/g, ' ');
  t = t
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * **v1 分块器的归一化**（不是我方规范形式）。
 *
 * 逆向自生产库 `PageEmbedding` 的 `chunkCharStart/chunkCharEnd`：
 * 拿 `PageVersion.textContent` 依次套 `strip()` → `\n{3,}→\n\n` → `[ \t]{2,}→' '`，
 * 长度与 `max(chunkCharEnd)` 在 500 页抽样里 468/494 = 94.7% 完全相等
 * （余下 26 页是 2026-04 生成 embedding 之后 textContent 又漂移了，见 docs）。
 *
 * 保留这个函数只为**复现 v1 的 chunk 边界做对比**，v2 写入路径不用它。
 */
export function normalizeV1ChunkerInput(s: string): string {
  let t = s.trim();
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}

// ─── 分块（复刻 v1 生成器）───────────────────────────────────────────────────

export interface Chunk {
  index: number;
  charStart: number;
  charEnd: number;
  content: string;
}

/** v1 生成器实测参数：定长窗口 1500 字符、步长 1300（重叠 200）、最多 16 块。 */
export const V1_CHUNK_WINDOW = 1500;
export const V1_CHUNK_STRIDE = 1300;
export const V1_CHUNK_MAX = 16;

/**
 * 码点数（**不是** `String.prototype.length`）。
 *
 * 这个区分是被实测逼出来的，不是洁癖：把 100 页真实抽取结果灌进 `serve.text_chunk` 时，
 * 675 条里有 **26 条**触发了 `tc_content_len` 约束
 * （`length(content) <> char_end - char_start`）。原因是 JS 的 `length`/`slice` 按
 * **UTF-16 码元**计数，而 Postgres 的 `length()`/`substr()` 按**码点**计数 ——
 * 语料里只要出现一个代理对（emoji、CJK 扩展 B 区生僻字，SCP 中文站里相当常见），
 * 两边的"字符位置"就永久错开。
 *
 * v1 那条链路没这个问题纯属侥幸：它的分块器是 Python 写的，`str` 索引本来就是码点。
 * 我们换成 TS 就必须显式对齐，否则 char_start/char_end 到了 SQL 侧全是错的偏移。
 */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * 复刻 v1 的分块：**纯字符定长滑窗，没有任何语义锚点**。
 * 这条性质是 embedding 重算决策的关键 —— 正文前 100 个字符改一个空格，
 * 后面每一块的边界与内容就全部平移。
 *
 * 单位是**码点**（见 codePointLength 的注释）：`Array.from` 一次把文本拆成码点数组，
 * 之后全部按数组下标切。代价是一份 O(n) 的数组，换来的是 char_start/char_end
 * 与 Postgres `substr()` 的口径完全一致。
 */
export function chunkLikeV1(
  normalizedText: string,
  window = V1_CHUNK_WINDOW,
  stride = V1_CHUNK_STRIDE,
  maxChunks = V1_CHUNK_MAX,
): Chunk[] {
  const cps = Array.from(normalizedText);
  const n = cps.length;
  if (n === 0) return [];
  const out: Chunk[] = [];
  for (let i = 0; i < maxChunks; i++) {
    const start = i * stride;
    if (start >= n && i > 0) break;
    const end = Math.min(start + window, n);
    out.push({ index: i, charStart: start, charEnd: end, content: cps.slice(start, end).join('') });
    if (end >= n) break;
  }
  return out;
}

// ─── 主提取 ──────────────────────────────────────────────────────────────────

interface Frame {
  tag: string;
  dropping: boolean;
}

/**
 * 从整页 HTML 提取正文。单遍扫描，O(html.length)。
 */
export function extractTextContent(html: string, opts: ExtractOptions = {}): ExtractResult {
  const warnings: string[] = [];
  const dropClasses = new Set(DROP_CLASSES);
  for (const c of opts.extraDropClasses ?? []) dropClasses.add(c);
  const dropIds = new Set(DROP_IDS);
  for (const i of opts.extraDropIds ?? []) dropIds.add(i);

  const located = locateContainer(html, warnings, opts.fallbackToBody === true);
  if (located === null) {
    return { text: '', containerFound: false, container: 'none', droppedSubtrees: 0, warnings };
  }

  const fragment = html.slice(located.start, located.end);
  const parts: string[] = [];
  const stack: Frame[] = [];
  let dropDepth = 0; // >0 表示当前在被丢弃的子树里
  let droppedSubtrees = 0;
  let i = 0;
  const n = fragment.length;

  const pushBreak = (): void => {
    if (dropDepth > 0) return;
    if (parts.length === 0) return;
    parts.push('\n');
  };

  while (i < n) {
    const lt = fragment.indexOf('<', i);
    if (lt < 0) {
      if (dropDepth === 0) parts.push(decodeEntities(fragment.slice(i)));
      break;
    }
    if (lt > i && dropDepth === 0) {
      parts.push(decodeEntities(fragment.slice(i, lt)));
    }

    // 注释 / CDATA / doctype
    if (fragment.startsWith('<!--', lt)) {
      const close = fragment.indexOf('-->', lt + 4);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (fragment.startsWith('<!', lt) || fragment.startsWith('<?', lt)) {
      const close = fragment.indexOf('>', lt + 2);
      i = close < 0 ? n : close + 1;
      continue;
    }

    const tagEnd = findTagEnd(fragment, lt);
    if (tagEnd < 0) {
      // 未闭合的 `<`：当普通文本处理，不要吞掉后面整篇。
      if (dropDepth === 0) parts.push('<');
      i = lt + 1;
      continue;
    }
    const raw = fragment.slice(lt, tagEnd + 1);
    i = tagEnd + 1;

    const isClose = raw[1] === '/';
    const tag = readTagName(raw, isClose);
    if (tag === '') continue;

    if (isClose) {
      // 出栈到匹配帧。找不到匹配（错配闭合）就忽略，不破坏栈。
      let k = stack.length - 1;
      while (k >= 0 && stack[k]!.tag !== tag) k--;
      if (k < 0) continue;
      for (let j = stack.length - 1; j >= k; j--) {
        const f = stack[j]!;
        if (f.dropping) dropDepth--;
        if (BLOCK_TAGS.has(f.tag)) pushBreak();
      }
      stack.length = k;
      continue;
    }

    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(tag);

    if (tag === 'br') {
      pushBreak();
      continue;
    }
    if (tag === 'hr') {
      pushBreak();
      continue;
    }

    let dropping = DROP_TAGS.has(tag);
    if (!dropping) {
      const cls = readAttr(raw, 'class');
      if (cls !== null) {
        for (const token of cls.split(/\s+/)) {
          if (token !== '' && dropClasses.has(token)) {
            dropping = true;
            break;
          }
        }
      }
    }
    if (!dropping) {
      const id = readAttr(raw, 'id');
      if (id !== null && dropIds.has(id)) dropping = true;
    }

    if (selfClosing) {
      // void/自闭合元素没有子树，dropping 无意义；只处理块级换行。
      if (BLOCK_TAGS.has(tag)) pushBreak();
      continue;
    }

    if (dropping) droppedSubtrees++;
    if (BLOCK_TAGS.has(tag)) pushBreak();
    if (dropping) dropDepth++;
    stack.push({ tag, dropping });

    // <script>/<style> 的内容不是标记语言，必须整体跳过而不是继续 tokenize
    // （里面的 `</div>` 字符串会把深度计数搞乱）。
    if (tag === 'script' || tag === 'style' || tag === 'template') {
      const closeIdx = findRawTextClose(fragment, i, tag);
      i = closeIdx < 0 ? n : closeIdx;
      // 让下一轮循环读到真正的 `</script>`，栈由那里出。
      if (closeIdx < 0) {
        warnings.push(`<${tag}> 未闭合`);
        // 手工出栈，避免 dropDepth 永久漏账
        const f = stack.pop();
        if (f?.dropping) dropDepth--;
      }
    }
  }

  // 收尾：栈里剩下的都是未闭合元素
  if (stack.length > 0) {
    warnings.push(`${stack.length} 个未闭合元素（最内层 <${stack[stack.length - 1]!.tag}>）`);
  }

  const text = normalizeExtracted(parts.join(''));
  if (text === '') warnings.push('提取结果为空');

  return {
    text,
    containerFound: located.container === 'page-content',
    container: located.container,
    droppedSubtrees,
    warnings,
  };
}

// ─── 容器定位 ────────────────────────────────────────────────────────────────

interface Located {
  start: number;
  end: number;
  container: 'page-content' | 'main-content' | 'document';
}

const PAGE_CONTENT_RE = /<div\b[^>]*\bid\s*=\s*(?:"page-content"|'page-content'|page-content[\s>])[^>]*>/i;
const MAIN_CONTENT_RE = /<div\b[^>]*\bid\s*=\s*(?:"main-content"|'main-content'|main-content[\s>])[^>]*>/i;

function locateContainer(html: string, warnings: string[], allowFallback: boolean): Located | null {
  for (const [re, name] of [
    [PAGE_CONTENT_RE, 'page-content'],
    [MAIN_CONTENT_RE, 'main-content'],
  ] as const) {
    if (name === 'main-content' && !allowFallback) continue;
    const m = re.exec(html);
    if (m === null) continue;
    const openEnd = m.index + m[0].length;
    const closeStart = matchDivClose(html, openEnd);
    if (closeStart < 0) {
      warnings.push(`#${name} 的 </div> 未找到（HTML 截断？）`);
      return { start: openEnd, end: html.length, container: name };
    }
    if (name === 'main-content') warnings.push('未找到 #page-content，退回 #main-content');
    return { start: openEnd, end: closeStart, container: name };
  }
  if (allowFallback) {
    warnings.push('未找到 #page-content / #main-content，退回整篇文档');
    return { start: 0, end: html.length, container: 'document' };
  }
  warnings.push('未找到 #page-content —— 拒绝提取（不把导航栏当正文）');
  return null;
}

/**
 * 从 `from` 开始按深度匹配 `</div>`。会跳过 script/style/注释里的假标签。
 * 返回匹配的 `</div>` 的起始下标；找不到返回 -1。
 */
function matchDivClose(html: string, from: number): number {
  let depth = 1;
  let i = from;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return -1;
    if (html.startsWith('<!--', lt)) {
      const c = html.indexOf('-->', lt + 4);
      i = c < 0 ? n : c + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, lt);
    if (tagEnd < 0) return -1;
    const raw = html.slice(lt, tagEnd + 1);
    const isClose = raw[1] === '/';
    const tag = readTagName(raw, isClose);
    if (tag === 'script' || tag === 'style' || tag === 'template') {
      if (!isClose && !raw.endsWith('/>')) {
        const c = findRawTextClose(html, tagEnd + 1, tag);
        i = c < 0 ? n : c;
        continue;
      }
    }
    if (tag === 'div') {
      if (isClose) {
        depth--;
        if (depth === 0) return lt;
      } else if (!raw.endsWith('/>')) {
        depth++;
      }
    }
    i = tagEnd + 1;
  }
  return -1;
}

// ─── 低层扫描辅助 ────────────────────────────────────────────────────────────

/** 找标签的 `>`，跳过属性值里的引号包裹部分。返回 `>` 下标，找不到返回 -1。 */
function findTagEnd(s: string, lt: number): number {
  let i = lt + 1;
  let quote = '';
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    } else if (c === '<') {
      // 属性外又出现 `<`：说明前一个 `<` 不是标签
      return -1;
    }
    i++;
  }
  return -1;
}

function readTagName(raw: string, isClose: boolean): string {
  let i = isClose ? 2 : 1;
  const n = raw.length;
  const start = i;
  while (i < n) {
    const c = raw.charCodeAt(i);
    const isName =
      (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58;
    if (!isName) break;
    i++;
  }
  return raw.slice(start, i).toLowerCase();
}

/** 读属性值（大小写不敏感，支持双引号/单引号/裸值）。缺失返回 null。 */
function readAttr(raw: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(raw);
  if (m === null) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/** 找 raw-text 元素（script/style/template）的闭合标签起始下标。 */
function findRawTextClose(s: string, from: number, tag: string): number {
  const needle = `</${tag}`;
  const idx = s.toLowerCase().indexOf(needle, from);
  return idx;
}
