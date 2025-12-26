// ftml-worker.js (ESM module worker)
//
// Place this file next to your HTML file.
// Requirements:
//  - Serve via HTTP(S) (not file://) so module worker can load.
//  - The FTML wasm bundle exists at ./ftml/ftml.js and ./ftml/ftml_bg.wasm

import initFtml, * as Ftml from "./ftml/ftml.js";

const {
  preprocess,
  tokenize,
  parse,
  PageInfo,
  WikitextSettings,
  version,
} = Ftml;

const DEFAULT_INTERWIKI_PREFIXES = {
  wikipedia: "https://wikipedia.org/wiki/$$",
  wp: "https://wikipedia.org/wiki/$$",
  commons: "https://commons.wikimedia.org/wiki/$$",
  google: "https://google.com/search?q=$$",
  duckduckgo: "https://duckduckgo.com/?q=$$",
  ddg: "https://duckduckgo.com/?q=$$",
  dictionary: "https://dictionary.com/browse/$$",
  thesaurus: "https://thesaurus.com/browse/$$",
};

const DEFAULT_SETTINGS_BY_MODE = {
  page: {
    enablePageSyntax: true,
    useIncludeCompatibility: false,
    useTrueIds: true,
    isolateUserIds: false,
    minifyCss: true,
    allowLocalPaths: true,
  },
  draft: {
    enablePageSyntax: true,
    useIncludeCompatibility: false,
    useTrueIds: false,
    isolateUserIds: false,
    minifyCss: true,
    allowLocalPaths: true,
  },
  "forum-post": {
    enablePageSyntax: false,
    useIncludeCompatibility: false,
    useTrueIds: false,
    isolateUserIds: false,
    minifyCss: true,
    allowLocalPaths: false,
  },
  "direct-message": {
    enablePageSyntax: false,
    useIncludeCompatibility: false,
    useTrueIds: false,
    isolateUserIds: false,
    minifyCss: true,
    allowLocalPaths: false,
  },
  list: {
    enablePageSyntax: true,
    useIncludeCompatibility: false,
    useTrueIds: false,
    isolateUserIds: false,
    minifyCss: true,
    allowLocalPaths: true,
  },
};

let wasmReady = false;
let wasmInitPromise = null;
let ftmlVersion = null;

// Include replacement cache (session memory):
// key: normalized include directive string -> { text, ts }
const includeReplacementCache = new Map();
const INCLUDE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let includeHits = 0;
let includeMisses = 0;

function nowMs() { return Date.now(); }

function normalizeIncludeKey(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 解析 include 指令，提取页面名和变量
 * 格式: [[include page-name | var1=value1 | var2=value2]]
 */
function parseIncludeDirective(raw) {
  const text = String(raw || "");
  // 移除 [[ 和 ]]
  const inner = text.replace(/^\[\[\s*include\s*/i, "").replace(/\s*\]\]$/, "");

  // 按 | 分割
  const parts = inner.split("|").map(p => p.trim());
  const pageName = parts[0] || "";

  // 解析变量
  const variables = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (key) variables[key] = value;
    }
  }

  return { pageName, variables };
}

/**
 * 替换文本中的 {$varname} 变量
 */
function replaceIncludeVariables(content, variables) {
  if (!content || !variables || Object.keys(variables).length === 0) {
    return content;
  }
  let result = String(content);
  const re = /\{\$([a-zA-Z0-9_\-]+)\}/g;
  result = result.replace(re, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      return variables[name];
    }
    return match; // 保留未匹配的变量
  });
  return result;
}

/**
 * 使用 Worker 的 fetch API 从 BFF 获取页面源码
 */
async function fetchPageSourceFromBff(bffBase, pageName, siteBase) {
  const base = String(bffBase || "").replace(/\/+$/, "");
  const site = String(siteBase || "").replace(/\/+$/, "");

  // 构建页面 URL
  const pageUrl = `${site}/${pageName}`;
  const encoded = encodeURIComponent(pageUrl);
  const requestUrl = `${base}/pages/latest-source?url=${encoded}`;

  try {
    const resp = await fetch(requestUrl);

    if (resp.status === 404) {
      return { ok: false, error: "not_found" };
    }
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    if (data && typeof data.source === "string") {
      return { ok: true, source: data.source };
    }
    // source 为 null 表示页面不存在
    if (data && data.source === null) {
      return { ok: false, error: "not_found" };
    }
    return { ok: true, source: "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function findIncludeDirectives(source) {
  // Very lightweight scanner. Covers the typical `[[include some-page]]` format.
  // If your wiki uses more complex include syntaxes, you can extend the regex.
  const text = String(source || "");
  const re = /\[\[\s*include\b([\s\S]*?)\]\]/gi;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const start = m.index;
    const end = re.lastIndex;
    const parsed = parseIncludeDirective(raw);
    out.push({
      start,
      end,
      raw,
      key: normalizeIncludeKey(raw),
      pageName: parsed.pageName,
      variables: parsed.variables,
    });
  }
  return out;
}

function buildLineStarts(text) {
  const s = String(text || "");
  const starts = [0];
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(lineStarts, offset) {
  const ls = lineStarts || [0];
  const len = ls.length;
  let off = Number(offset || 0);
  if (!Number.isFinite(off)) off = 0;
  if (off < 0) off = 0;
  // binary search: last lineStart <= off
  let lo = 0, hi = len - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ls[mid];
    if (v <= off) lo = mid + 1;
    else hi = mid - 1;
  }
  const line = Math.max(0, hi);
  const col = off - ls[line];
  return { line, col };
}

function lineColToOffset(text, lineStarts, line, col) {
  const ls = lineStarts || [0];
  const s = String(text || "");
  const l = Math.min(Math.max(0, Number(line || 0)), Math.max(0, ls.length - 1));
  const lineStart = ls[l] ?? 0;
  // find line end
  const lineEnd = (l + 1 < ls.length) ? (ls[l + 1] - 1) : s.length;
  const maxCol = Math.max(0, lineEnd - lineStart);
  const c = Math.min(Math.max(0, Number(col || 0)), maxCol);
  return lineStart + c;
}

function createWikitextSettings(mode, layout) {
  if (!WikitextSettings) return null;

  if (typeof WikitextSettings.from_mode === "function") {
    try {
      return WikitextSettings.from_mode(mode, layout);
    } catch {
      // fall through
    }
  }

  const defaults = DEFAULT_SETTINGS_BY_MODE[mode] || DEFAULT_SETTINGS_BY_MODE.page;
  const payload = {
    mode,
    layout,
    "enable-page-syntax": defaults.enablePageSyntax,
    "use-include-compatibility": defaults.useIncludeCompatibility,
    "use-true-ids": defaults.useTrueIds,
    "isolate-user-ids": defaults.isolateUserIds,
    "minify-css": defaults.minifyCss,
    "allow-local-paths": defaults.allowLocalPaths,
    interwiki: { ...DEFAULT_INTERWIKI_PREFIXES },
  };

  try {
    return new WikitextSettings(payload);
  } catch {
    return null;
  }
}

async function ensureInitialized() {
  if (wasmReady) return;
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const wasmUrl = new URL("./ftml/ftml_bg.wasm", import.meta.url);
      await initFtml({ module_or_path: wasmUrl });
      wasmReady = true;
      try { ftmlVersion = typeof version === "function" ? version() : null; }
      catch { ftmlVersion = null; }
    })().catch((e) => {
      wasmInitPromise = null;
      throw e;
    });
  }
  return wasmInitPromise;
}

function getRenderFn() {
  if (typeof Ftml.render_html === "function") return Ftml.render_html;
  if (typeof Ftml.render_text === "function") return Ftml.render_text;
  return null;
}

function pruneExpiredIncludeCache() {
  const t = nowMs();
  for (const [k, v] of includeReplacementCache.entries()) {
    if (!v || !v.ts) {
      includeReplacementCache.delete(k);
      continue;
    }
    if (t - v.ts > INCLUDE_CACHE_TTL_MS) includeReplacementCache.delete(k);
  }
}

function buildSyntheticOffsetMapForIncludes(source, directives, replacements) {
  // Build offset_map-like segments mapping expanded text positions back to original.
  const text = String(source || "");
  const dirs = Array.isArray(directives) ? directives : [];
  const map = [];
  const parts = [];

  let last = 0;
  let newPos = 0;

  for (const d of dirs) {
    const start = d.start ?? 0;
    const end = d.end ?? start;
    if (start < last) continue;

    const before = text.slice(last, start);
    parts.push(before);
    map.push({
      new_start: newPos,
      new_end: newPos + before.length,
      orig_start: last,
      orig_end: start,
    });
    newPos += before.length;

    const rep = replacements.get(d.key)?.text ?? "";
    parts.push(rep);
    map.push({
      new_start: newPos,
      new_end: newPos + rep.length,
      orig_start: start,
      orig_end: end,
    });
    newPos += rep.length;

    last = end;
  }

  const tail = text.slice(last);
  parts.push(tail);
  map.push({
    new_start: newPos,
    new_end: newPos + tail.length,
    orig_start: last,
    orig_end: text.length,
  });

  return { text: parts.join(""), offset_map: map };
}

function mapOffsetExpandedToOriginal(offsetMap, expandedOffset) {
  const off = Number(expandedOffset || 0);
  const segs = Array.isArray(offsetMap) ? offsetMap : [];
  if (!segs.length) return off;

  // binary search segment by new_start/new_end
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segs[mid];
    const ns = Number(seg.new_start || 0);
    const ne = Number(seg.new_end || 0);
    if (off < ns) hi = mid - 1;
    else if (off >= ne) lo = mid + 1;
    else {
      const os = Number(seg.orig_start || 0);
      const oe = Number(seg.orig_end || 0);
      const newLen = Math.max(0, ne - ns);
      const origLen = Math.max(0, oe - os);

      if (newLen <= 0 || origLen <= 0) return os;

      const rel = off - ns;
      const ratio = rel / newLen;
      const mapped = os + Math.floor(ratio * origLen);
      return Math.max(os, Math.min(oe, mapped));
    }
  }
  // If not found, fall back to near-bound
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (off < Number(first.new_start || 0)) return Number(first.orig_start || 0);
  return Number(last.orig_end || off);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function extractIncludeReplacementsFromExpanded(source, expandedText, offsetMap, directives) {
  // For each include directive range in original, find overlapping segments in offsetMap
  // and take the union of their new ranges as the replacement content.
  const dirs = Array.isArray(directives) ? directives : [];
  const segs = Array.isArray(offsetMap) ? offsetMap : [];

  for (const d of dirs) {
    const os = Number(d.start ?? 0);
    const oe = Number(d.end ?? os);
    let newStart = null;
    let newEnd = null;

    for (const seg of segs) {
      const sOs = Number(seg.orig_start ?? 0);
      const sOe = Number(seg.orig_end ?? 0);
      if (!overlaps(sOs, sOe, os, oe)) continue;

      const sNs = Number(seg.new_start ?? 0);
      const sNe = Number(seg.new_end ?? 0);
      if (newStart == null || sNs < newStart) newStart = sNs;
      if (newEnd == null || sNe > newEnd) newEnd = sNe;
    }

    if (newStart == null || newEnd == null || newEnd < newStart) continue;

    const rep = String(expandedText || "").slice(newStart, newEnd);
    if (rep) {
      includeReplacementCache.set(d.key, { text: rep, ts: nowMs() });
    }
  }
}

/**
 * 使用 Worker 的 fetch API 展开单层 include（支持递归展开）
 */
async function expandIncludesOnePass(text, includeApi, includeBaseUrl, maxDepth = 10) {
  if (maxDepth <= 0) {
    return { text, changed: false };
  }

  const directives = findIncludeDirectives(text);
  if (directives.length === 0) {
    return { text, changed: false };
  }

  // 收集所有需要的唯一页面
  const uniquePages = new Map(); // pageName -> directive[]

  for (const d of directives) {
    if (!uniquePages.has(d.pageName)) {
      uniquePages.set(d.pageName, []);
    }
    uniquePages.get(d.pageName).push(d);
  }

  // 并行获取所有唯一页面
  const pageResults = new Map();
  const fetchTasks = [];
  for (const pageName of uniquePages.keys()) {
    fetchTasks.push(
      fetchPageSourceFromBff(includeApi, pageName, includeBaseUrl)
        .then(result => pageResults.set(pageName, result))
    );
  }
  await Promise.all(fetchTasks);

  // 从后往前替换，保持索引有效
  let result = text;
  const sortedDirectives = [...directives].sort((a, b) => b.start - a.start);

  for (const d of sortedDirectives) {
    const fetchResult = pageResults.get(d.pageName);
    let replacement;

    if (fetchResult && fetchResult.ok) {
      // 替换变量
      replacement = replaceIncludeVariables(fetchResult.source, d.variables);
    } else {
      // 页面不存在或获取失败
      const errorMsg = fetchResult?.error || "unknown";
      replacement = `[[div class="wj-error"]]\nInclude 失败: ${d.pageName} (${errorMsg})\n[[/div]]`;
    }

    result = result.slice(0, d.start) + replacement + result.slice(d.end);
  }

  return { text: result, changed: true };
}

async function expandIncludesSmart(source, settings, includeMode, includeApi, includeBaseUrl) {
  const text = String(source || "");
  const mode = includeMode || "hybrid";
  pruneExpiredIncludeCache();

  const directives = findIncludeDirectives(text);

  if (mode === "disabled" || directives.length === 0) {
    return {
      text,
      offset_map: [],
      includeStats: { hits: includeHits, misses: includeMisses, lastMode: mode, lastNote: directives.length ? "未展开" : "无 include" },
      used: "none",
      directives,
    };
  }

  // Check cache availability for all directives
  let allCached = true;
  for (const d of directives) {
    const v = includeReplacementCache.get(d.key);
    if (!v || !v.text) { allCached = false; break; }
  }

  if (mode === "cache-only" || (mode === "hybrid" && allCached)) {
    // Use cached replacements (no network)
    if (!allCached) {
      includeMisses += 1;
      // Fallback: do not expand missing ones, keep raw directive text.
      // This keeps offsets stable and avoids network in cache-only mode.
      return {
        text,
        offset_map: [],
        includeStats: { hits: includeHits, misses: includeMisses, lastMode: mode, lastNote: "缓存不足，保持原样" },
        used: "cache-miss-no-network",
        directives,
      };
    }

    includeHits += 1;
    const synthetic = buildSyntheticOffsetMapForIncludes(text, directives, includeReplacementCache);
    return {
      text: synthetic.text,
      offset_map: synthetic.offset_map,
      includeStats: { hits: includeHits, misses: includeMisses, lastMode: mode, lastNote: "使用缓存" },
      used: "cache",
      directives,
    };
  }

  // 优先使用 FTML 的 expand_includes_via_bff（已修复支持 Worker 环境）
  includeMisses += 1;

  // 尝试使用 FTML 原生 includer
  if (typeof Ftml.expand_includes_via_bff === "function") {
    try {
      const expandedResult = await Ftml.expand_includes_via_bff(
        text,
        settings,
        includeApi,
        includeBaseUrl
      );

      const expandedObj = expandedResult || {};
      const expandedText = expandedObj.text || text;
      const offsetMap = Array.isArray(expandedObj.offset_map) ? expandedObj.offset_map : [];

      // 更新缓存
      if (directives.length > 0 && offsetMap.length > 0) {
        try {
          extractIncludeReplacementsFromExpanded(text, expandedText, offsetMap, directives);
        } catch {
          // ignore cache extraction errors
        }
      }

      return {
        text: expandedText,
        offset_map: offsetMap,
        includeStats: { hits: includeHits, misses: includeMisses, lastMode: mode, lastNote: "FTML 展开" },
        used: "ftml",
        directives,
      };
    } catch (e) {
      console.warn("[FTML Worker] FTML includer 失败，回退到 Worker fetch:", e);
    }
  }

  // 回退：使用 Worker fetch 进行 BFF 展开
  let expandedText = text;
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    const result = await expandIncludesOnePass(expandedText, includeApi, includeBaseUrl, maxIterations - i);
    if (!result.changed) {
      break;
    }
    expandedText = result.text;
  }

  // 构建 offset map（简化版：整体映射）
  const offsetMap = buildSyntheticOffsetMapForIncludes(text, directives, new Map(
    directives.map(d => {
      const cached = includeReplacementCache.get(d.key);
      return [d.key, cached || { text: "", ts: nowMs() }];
    })
  )).offset_map;

  return {
    text: expandedText,
    offset_map: offsetMap,
    includeStats: { hits: includeHits, misses: includeMisses, lastMode: mode, lastNote: "Worker fetch 展开" },
    used: "worker-fetch",
    directives,
  };
}

function detectViaInclude(source, directives, origOffset) {
  if (!Array.isArray(directives) || directives.length === 0) return false;
  const off = Number(origOffset || 0);
  for (const d of directives) {
    const s = Number(d.start ?? 0);
    const e = Number(d.end ?? s);
    if (off >= s && off <= e) return true;
  }
  // Additionally: check original text around offset
  const snippet = String(source || "").slice(Math.max(0, off - 40), Math.min(String(source || "").length, off + 40));
  return /\[\[\s*include\b/i.test(snippet);
}

function serializeErrors(errorsRaw, source, expandedText, preprocessed, offsetMap, directives) {
  const out = [];
  const src = String(source || "");
  const exp = String(expandedText || "");
  const pre = String(preprocessed || "");

  const srcLS = buildLineStarts(src);
  const expLS = buildLineStarts(exp);
  const preLS = buildLineStarts(pre);

  for (const er of (errorsRaw || [])) {
    const kind = er?.kind || "UNKNOWN";
    const rule = er?.rule || "";
    const message = er?.message || (typeof er === "string" ? er : JSON.stringify(er, null, 2));

    let startOffset =
      (er?.span && typeof er.span === "object" && ("start" in er.span)) ? er.span.start :
      (Array.isArray(er?.span) ? er.span[0] : undefined);

    if (startOffset == null) startOffset = 0;
    const preOff = Number(startOffset) || 0;

    // Map: preprocessed offset -> (line,col) in preprocessed -> offset in expanded by same (line,col)
    const plc = offsetToLineCol(preLS, preOff);
    const expOff = lineColToOffset(exp, expLS, plc.line, plc.col);

    // Map: expanded offset -> original offset (include offset map)
    const origOff = mapOffsetExpandedToOriginal(offsetMap, expOff);

    const loc = offsetToLineCol(srcLS, origOff);
    const viaInclude = detectViaInclude(src, directives, origOff);

    out.push({
      kind,
      rule,
      message,
      loc: { line: loc.line + 1, col: loc.col + 1 }, // 1-based for UI
      viaInclude,
      _debug: {
        pre: { line: plc.line + 1, col: plc.col + 1, offset: preOff },
        exp: { offset: expOff },
        orig: { offset: origOff },
      },
    });
  }

  return out;
}

async function doRender(req) {
  const started = performance.now();

  const source = String(req?.source || "");
  const mode = String(req?.mode || "page");
  const layout = String(req?.layout || "wikidot");
  const includeMode = String(req?.includeMode || "hybrid");
  const includeApi = String(req?.includeApi || "");
  const includeBaseUrl = String(req?.includeBaseUrl || "");
  const pageMeta = req?.pageMeta || {};

  await ensureInitialized();

  // NOTE:
  // In wasm-bindgen exports, some functions may CONSUME objects (Rust ownership),
  // and the JS wrapper becomes a null pointer afterwards. The original demo
  // intentionally used separate PageInfo / WikitextSettings for parse vs render.
  // We follow the same pattern here to avoid "null pointer passed to rust".
  const includeSettings = createWikitextSettings(mode, layout);
  if (!includeSettings) throw new Error("WikitextSettings 构造失败（includeSettings）。");

  // ---- include expand (在 Worker 中使用 fetch API) ----
  const t_inc = performance.now();
  let expandedText = source;
  let includeOffsetMap = [];
  let directives = [];
  let includeStats = { hits: includeHits, misses: includeMisses, lastMode: includeMode, lastNote: "" };

  try {
    const expandResult = await expandIncludesSmart(
      source,
      includeSettings,
      includeMode,
      includeApi,
      includeBaseUrl
    );
    expandedText = expandResult.text || source;
    includeOffsetMap = expandResult.offset_map || [];
    directives = expandResult.directives || [];
    includeStats = expandResult.includeStats || includeStats;
  } catch (e) {
    // Include 展开失败，继续使用原始源码
    console.warn("[FTML Worker] include 展开失败，使用原始源码：", e);
    includeStats.lastNote = "展开失败: " + String(e);
  }
  const includeMs = performance.now() - t_inc;

  // ---- preprocess ----
  const t0 = performance.now();
  let preprocessed = "";
  try {
    const maybe = preprocess(expandedText);
    preprocessed = (typeof maybe === "string") ? maybe : String(expandedText);
  } catch (e) {
    throw new Error("preprocess() 失败：" + String(e));
  }
  const preprocessMs = performance.now() - t0;

  // ---- tokenize ----
  const t1 = performance.now();
  let tokenization;
  try {
    tokenization = tokenize(preprocessed);
  } catch (e) {
    throw new Error("tokenize() 失败：" + String(e));
  }
  const tokenizeMs = performance.now() - t1;

  // ---- parse (use a dedicated PageInfo + Settings) ----
  const t2 = performance.now();

  let parsePageInfo;
  try {
    parsePageInfo = new PageInfo(pageMeta);
  } catch {
    parsePageInfo = new PageInfo();
  }

  const parseSettings = createWikitextSettings(mode, layout);
  if (!parseSettings) throw new Error("WikitextSettings 构造失败（parseSettings）。");

  let outcome;
  try {
    outcome = parse(tokenization, parsePageInfo, parseSettings);
  } catch (e) {
    throw new Error("parse() 失败：" + String(e));
  }
  const parseMs = performance.now() - t2;

  let errorsRaw = [];
  try {
    if (outcome && typeof outcome.errors === "function") {
      const tmp = outcome.errors() ?? [];
      if (Array.isArray(tmp)) errorsRaw = tmp;
    }
  } catch {
    // ignore
  }

  let syntaxTree;
  try {
    syntaxTree = outcome.syntax_tree();
  } catch (e) {
    throw new Error("提取语法树失败：" + String(e));
  }

  if (!syntaxTree || !syntaxTree.__wbg_ptr) {
    throw new Error("SyntaxTree 不可用（解析阶段出现致命错误）。");
  }

  // ---- render (use a dedicated PageInfo + Settings) ----
  const renderFn = getRenderFn();
  if (!renderFn) throw new Error("FTML 未导出 render_html / render_text。");

  let renderPageInfo;
  try {
    renderPageInfo = new PageInfo(pageMeta);
  } catch {
    renderPageInfo = new PageInfo();
  }

  const renderSettings = createWikitextSettings(mode, layout);
  if (!renderSettings) throw new Error("WikitextSettings 构造失败（renderSettings）。");

  const t3 = performance.now();
  let renderOut;
  try {
    renderOut = renderFn(syntaxTree, renderPageInfo, renderSettings);
  } catch (e) {
    throw new Error("渲染函数失败：" + String(e));
  }
  const renderMs = performance.now() - t3;

  let html = "";
  if (renderOut && typeof renderOut.body === "function") html = renderOut.body();
  else if (typeof renderOut === "string") html = renderOut;
  else html = String(renderOut ?? "");

  // ---- serialize mapped errors (fix include offset issues) ----
  const mappedErrors = serializeErrors(
    errorsRaw,
    source,
    expandedText,
    preprocessed,
    includeOffsetMap,
    directives
  );

  const totalMs = performance.now() - started;

  return {
    html,
    errors: mappedErrors,
    timings: {
      include: includeMs,
      preprocess: preprocessMs,
      tokenize: tokenizeMs,
      parse: parseMs,
      render: renderMs,
      total: totalMs,
    },
    includeStats,
    noteText:
      (includeMode !== "disabled" && directives.length > 0)
        ? `include 指令 ${directives.length} 个；策略：${includeMode}；${includeStats.lastNote || ""}`
        : "",
  };
}

self.addEventListener("message", async (ev) => {
  const msg = ev.data || {};
  const type = msg.type;

  if (type === "init") {
    try {
      await ensureInitialized();
      self.postMessage({ type: "worker-ready", version: ftmlVersion || null });
    } catch (e) {
      self.postMessage({ type: "worker-ready", version: null });
      // We still report ready; render will surface errors.
    }
    return;
  }

  if (type === "clear-include-cache") {
    includeReplacementCache.clear();
    includeHits = 0;
    includeMisses = 0;
    self.postMessage({ type: "include-cache-cleared" });
    return;
  }

  if (type === "render") {
    const seq = msg.seq || 0;
    try {
      const result = await doRender(msg);
      self.postMessage({ type: "render-result", seq, ok: true, ...result });
    } catch (e) {
      const errText = (e && e.stack) ? String(e.stack) : String(e);
      self.postMessage({
        type: "render-result",
        seq,
        ok: false,
        error: errText,
        includeStats: { hits: includeHits, misses: includeMisses, lastMode: String(msg.includeMode || ""), lastNote: "错误" },
      });
    }
  }
});
