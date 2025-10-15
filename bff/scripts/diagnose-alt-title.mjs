#!/usr/bin/env node
// Diagnose why alternateTitle is null for a specific page in /users/:wikidotId/pages
// Usage:
//   node bff/scripts/diagnose-alt-title.mjs --base https://scpper.mer.run/api --user 7820392 --page 508551024 --limit 2 --offset 0

const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const m = s.match(/^--([^=]+)=(.*)$/);
  if (m) return [m[1], m[2]];
  const m2 = s.match(/^--(.+)$/);
  if (m2) return [m2[1], true];
  return [s, true];
}));

const base = (args.base || 'https://scpper.mer.run/api').replace(/\/$/, '');
const userId = Number(args.user || 7820392);
const pageId = Number(args.page || 508551024);
const limit = Number(args.limit || 2);
const offset = Number(args.offset || 0);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function log(title, obj) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function pickFields(obj, fields) {
  const out = {};
  for (const k of fields) out[k] = obj?.[k] ?? null;
  return out;
}

(async () => {
  try {
    const worksUrl = `${base}/users/${encodeURIComponent(String(userId))}/pages?tab=all&includeDeleted=true&sortBy=rating&sortDir=desc&limit=${limit}&offset=${offset}`;
    const works = await getJson(worksUrl);
    log('Works Endpoint', { url: worksUrl, count: Array.isArray(works) ? works.length : 0 });

    const entry = Array.isArray(works) ? works.find((w) => Number(w?.wikidotId) === pageId) : null;
    if (!entry) {
      log('Entry Not Found In Page Slice', { pageId, hint: 'Try increasing limit/adjusting offset' });
    } else {
      log('Works Entry', pickFields(entry, ['wikidotId', 'title', 'alternateTitle', 'category', 'rating', 'isDeleted', 'groupKey']));
    }

    // By-id (latest snapshot merged)
    const byIdUrl = `${base}/pages/by-id?wikidotId=${encodeURIComponent(String(pageId))}`;
    let byId = null;
    try { byId = await getJson(byIdUrl); } catch (e) { byId = { error: String(e) }; }
    log('Page By ID', { url: byIdUrl, data: pickFields(byId || {}, ['wikidotId', 'title', 'alternateTitle', 'isDeleted', 'deletedAt', 'category', 'rating']) });

    // Versions
    const versionsUrl = `${base}/pages/${encodeURIComponent(String(pageId))}/versions?limit=20`;
    let versions = [];
    try { versions = await getJson(versionsUrl); } catch (e) { versions = { error: String(e) }; }
    if (Array.isArray(versions)) {
      const compact = versions.map((v) => pickFields(v, ['pageVersionId', 'createdAt', 'validFrom', 'validTo', 'title', 'alternateTitle']));
      log('Versions (Top 10)', compact.slice(0, 10));
    } else {
      log('Versions Error', versions);
    }

    // Attributions for effective version of this page
    const attrsUrl = `${base}/pages/${encodeURIComponent(String(pageId))}/attributions`;
    let attrs = [];
    try { attrs = await getJson(attrsUrl); } catch (e) { attrs = { error: String(e) }; }
    log('Attributions (effective version)', Array.isArray(attrs) ? attrs : { error: attrs.error || 'unknown' });

    // Heuristic diagnostics
    const worksAlt = entry?.alternateTitle ?? null;
    const byIdAlt = byId?.alternateTitle ?? null;
    let liveAlt = null;
    let liveTitle = null;
    if (Array.isArray(versions)) {
      const live = versions.find((v) => v && (v.validTo == null));
      if (live) { liveAlt = live.alternateTitle ?? null; liveTitle = live.title ?? null; }
    }
    log('Heuristic', { worksAlt, byIdAlt, liveAlt, liveTitle });

    const notes = [];
    if (worksAlt == null && (byIdAlt || liveAlt)) {
      notes.push('Likely server is selecting alternateTitle from an older/effective PV where it is null, while latest snapshot has a value.');
    }
    if (worksAlt == null && byIdAlt == null && liveAlt == null) {
      notes.push('All sources show alternateTitle = null; page may truly have no alternate title.');
    }
    if (entry && entry.isDeleted === true) {
      notes.push('Entry is deleted; ensure effective vs live PV resolution in server logic.');
    }
    log('Conclusion', { summary: notes.length ? notes : ['No discrepancies detected'], hint: 'Compare effective vs live PV logic on server for fields.' });

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

