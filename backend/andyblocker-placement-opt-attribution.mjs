import pg from 'pg';
import { computePlacementMetrics } from '../user-backend/src/routes/gacha/runtime.ts';

const { Pool } = pg;

const DB_CFG = {
  host: '127.0.0.1',
  port: 5434,
  user: '***REMOVED***',
  password: '***REMOVED***'
};

const USER_ID = 'cmgefehmh0003epu3atyfn35z';

const BASE_BY_RARITY = {
  WHITE: 0.5,
  GREEN: 0.7,
  BLUE: 1.0,
  PURPLE: 1.5,
  GOLD: 2.0
};

function normalizeAuthorKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[#@]+/, '')
    .replace(/[\s_:\-\/\\\.]+/g, '');
}

function parseStyles(sig) {
  const raw = String(sig || 'NONE').toUpperCase();
  if (!raw) return ['NONE'];
  return raw.split('+').map((s) => s.trim()).filter(Boolean);
}

function styleHeuristic(styles) {
  let score = 0;
  for (const s of styles) {
    if (s === 'COLORLESS') score += 2.6;
    else if (s === 'GOLD') score += 2.1;
    else if (s === 'PRISM') score += 1.45;
    else if (s === 'SILVER') score += 1.2;
    else if (s === 'CYAN') score += 1.05;
    else if (s === 'MONO') score += 0.9;
    else if (s === 'WILDCARD') score += 0.9;
    else if (s === 'SPECTRUM') score += 0.65;
    else if (s === 'MIRROR') score += 0.75;
    else if (s === 'ORBIT') score += 0.7;
    else if (s === 'ECHO') score += 0.55;
  }
  return score;
}

function instanceHeuristic(inst) {
  return (BASE_BY_RARITY[inst.card.rarity] ?? 0) * 10 + styleHeuristic(inst.styles) + (inst.styles.includes('NONE') ? -0.6 : 0);
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sampleUnique(pool, count) {
  if (count >= pool.length) return [...pool];
  return shuffle(pool).slice(0, count);
}

function buildSlots(userId, slotInsts) {
  return slotInsts.map((inst, idx) => ({
    id: `slot-${idx + 1}`,
    userId,
    slotIndex: idx + 1,
    cardId: inst.cardId,
    inventoryId: null,
    instanceId: inst.id,
    affixVisualStyle: null,
    affixSignature: inst.affixSignature,
    affixLabel: inst.affixLabel,
    assignedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    card: inst.card,
    instance: { isLocked: false }
  }));
}

function buildAddons(userId, addonInst) {
  if (!addonInst) return [];
  return [{
    id: 'addon-colorless',
    userId,
    kind: 'COLORLESS',
    cardId: addonInst.cardId,
    affixVisualStyle: addonInst.affixVisualStyle,
    affixSignature: addonInst.affixSignature,
    affixLabel: addonInst.affixLabel,
    inventoryId: null,
    assignedAt: new Date(),
    card: addonInst.card,
    isLocked: false
  }];
}

function evaluate(userId, stateObj, slotInsts, addonInst) {
  return computePlacementMetrics(userId, stateObj, buildSlots(userId, slotInsts), buildAddons(userId, addonInst));
}

function pickBestAddon(userId, stateObj, slotInsts, addonPool, currentAddon) {
  const used = new Set(slotInsts.map((s) => s.id));
  let bestAddon = currentAddon;
  let bestMetrics = evaluate(userId, stateObj, slotInsts, currentAddon);
  for (const cand of addonPool) {
    if (used.has(cand.id)) continue;
    const metrics = evaluate(userId, stateObj, slotInsts, cand);
    if (metrics.estimatedYieldPerHour > bestMetrics.estimatedYieldPerHour + 1e-9) {
      bestMetrics = metrics;
      bestAddon = cand;
    }
  }
  return { addon: bestAddon, metrics: bestMetrics };
}

function localOptimize(userId, stateObj, slotInstsInit, addonInit, slotPool, addonPool, maxPasses = 10) {
  let slotInsts = [...slotInstsInit];
  let addonInst = addonInit;

  let addonPick = pickBestAddon(userId, stateObj, slotInsts, addonPool, addonInst);
  addonInst = addonPick.addon;
  let bestMetrics = addonPick.metrics;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    const used = new Set(slotInsts.map((s) => s.id));
    if (addonInst) used.add(addonInst.id);

    for (let idx = 0; idx < slotInsts.length; idx += 1) {
      const current = slotInsts[idx];
      let bestLocal = bestMetrics;
      let bestCand = current;

      used.delete(current.id);
      for (const cand of slotPool) {
        if (used.has(cand.id)) continue;
        slotInsts[idx] = cand;
        const metrics = evaluate(userId, stateObj, slotInsts, addonInst);
        if (metrics.estimatedYieldPerHour > bestLocal.estimatedYieldPerHour + 1e-9) {
          bestLocal = metrics;
          bestCand = cand;
        }
      }
      slotInsts[idx] = bestCand;
      used.add(bestCand.id);

      if (bestCand.id !== current.id) {
        bestMetrics = bestLocal;
        improved = true;
      }
    }

    addonPick = pickBestAddon(userId, stateObj, slotInsts, addonPool, addonInst);
    if ((addonInst?.id ?? null) !== (addonPick.addon?.id ?? null)
      || addonPick.metrics.estimatedYieldPerHour > bestMetrics.estimatedYieldPerHour + 1e-9) {
      addonInst = addonPick.addon;
      bestMetrics = addonPick.metrics;
      improved = true;
    }

    if (!improved) break;
  }

  return { slotInsts, addonInst, metrics: bestMetrics };
}

async function loadAuthorKeysByPage(coreDb, pageIds) {
  if (!pageIds.length) return new Map();
  const rs = await coreDb.query(`
    WITH latest AS (
      SELECT DISTINCT ON (pv."pageId") pv.id, pv."pageId"
      FROM "PageVersion" pv
      WHERE pv."pageId" = ANY($1::int[])
      ORDER BY pv."pageId", (pv."validTo" IS NULL) DESC, pv."validFrom" DESC, pv.id DESC
    )
    SELECT l."pageId", a.type, a."order", a."userId", a."anonKey", u.username, u."displayName"
    FROM latest l
    LEFT JOIN "Attribution" a ON a."pageVerId" = l.id
    LEFT JOIN "User" u ON u.id = a."userId"
    WHERE a.type IN ('AUTHOR','TRANSLATOR','SUBMITTER')
    ORDER BY l."pageId", CASE a.type WHEN 'AUTHOR' THEN 1 WHEN 'TRANSLATOR' THEN 2 ELSE 3 END, a."order" NULLS LAST
  `, [pageIds]);

  const grouped = new Map();
  for (const row of rs.rows) {
    const pageId = Number(row.pageId ?? row.pageid);
    if (!grouped.has(pageId)) grouped.set(pageId, { primary: [], submitter: [] });
    const label = String(row.username || row.displayName || row.displayname || row.anonKey || row.anonkey || '').trim();
    if (!label) continue;
    const key = normalizeAuthorKey(label);
    if (!key) continue;
    if (row.type === 'AUTHOR' || row.type === 'TRANSLATOR') {
      grouped.get(pageId).primary.push(key);
    } else if (row.type === 'SUBMITTER') {
      grouped.get(pageId).submitter.push(key);
    }
  }

  const byPage = new Map();
  for (const [pageId, rec] of grouped.entries()) {
    const primary = [...new Set(rec.primary)];
    const submitter = [...new Set(rec.submitter)];
    byPage.set(pageId, primary.length ? primary : submitter);
  }
  return byPage;
}

(async () => {
  const userDb = new Pool({ ...DB_CFG, database: 'scpper_user' });
  const coreDb = new Pool({ ...DB_CFG, database: 'scpper-cn' });

  try {
    const stateRs = await userDb.query(`
      SELECT id, "unlockedSlotCount", "pendingToken", "lastAccrualAt", "createdAt", "updatedAt"
      FROM "GachaPlacementState"
      WHERE "userId" = $1
      LIMIT 1
    `, [USER_ID]);
    if (!stateRs.rows.length) throw new Error('Placement state not found');
    const state = {
      id: stateRs.rows[0].id,
      userId: USER_ID,
      unlockedSlotCount: Number(stateRs.rows[0].unlockedSlotCount ?? stateRs.rows[0].unlockedslotcount ?? 10),
      pendingToken: Number(stateRs.rows[0].pendingToken ?? stateRs.rows[0].pendingtoken ?? 0),
      lastAccrualAt: new Date(stateRs.rows[0].lastAccrualAt ?? stateRs.rows[0].lastaccrualat),
      createdAt: new Date(stateRs.rows[0].createdAt ?? stateRs.rows[0].createdat),
      updatedAt: new Date(stateRs.rows[0].updatedAt ?? stateRs.rows[0].updatedat)
    };

    const placementRs = await userDb.query(`
      SELECT "slotIndex", "instanceId"
      FROM "GachaPlacementSlot"
      WHERE "userId" = $1
      ORDER BY "slotIndex" ASC
    `, [USER_ID]);

    const instRs = await userDb.query(`
      SELECT
        ci.id,
        ci."cardId",
        COALESCE(ci."affixSignature", 'NONE') AS "affixSignature",
        ci."affixLabel",
        ci."affixVisualStyle",
        c.rarity,
        c.title,
        c."pageId",
        c.tags
      FROM "GachaCardInstance" ci
      JOIN "GachaCardDefinition" c ON c.id = ci."cardId"
      WHERE ci."userId" = $1
        AND ci."tradeListingId" IS NULL
        AND ci."buyRequestId" IS NULL
    `, [USER_ID]);

    const rawInstances = instRs.rows;
    const pageIds = [...new Set(rawInstances.map((r) => Number(r.pageId ?? r.pageid)).filter((n) => Number.isFinite(n) && n > 0))];
    const authorKeysByPage = await loadAuthorKeysByPage(coreDb, pageIds);

    const allInstances = rawInstances.map((r) => {
      const pageId = Number(r.pageId ?? r.pageid);
      const authorKeys = authorKeysByPage.get(pageId) ?? [];
      const origTags = Array.isArray(r.tags) ? r.tags : [];
      const authorTags = authorKeys.map((k) => `author:${k}`);
      return {
        id: r.id,
        cardId: r.cardId ?? r.cardid,
        affixSignature: String(r.affixSignature || 'NONE').toUpperCase(),
        affixLabel: r.affixLabel ?? r.affixlabel ?? null,
        affixVisualStyle: r.affixVisualStyle ?? r.affixvisualstyle ?? null,
        styles: parseStyles(r.affixSignature),
        card: {
          id: r.cardId ?? r.cardid,
          title: r.title,
          rarity: r.rarity,
          pageId,
          tags: [...origTags, ...authorTags]
        }
      };
    });

    const byId = new Map(allInstances.map((x) => [x.id, x]));
    const goldPool = allInstances.filter((x) => x.card.rarity === 'GOLD');
    const addonPool = allInstances.filter((x) => x.styles.includes('COLORLESS'));

    if (goldPool.length < 10) throw new Error(`Not enough GOLD instances (${goldPool.length})`);
    if (!addonPool.length) throw new Error('No COLORLESS addon candidates');

    const sortedGold = [...goldPool].sort((a, b) => instanceHeuristic(b) - instanceHeuristic(a));
    const sortedAddon = [...addonPool].sort((a, b) => instanceHeuristic(b) - instanceHeuristic(a));

    const currentSlots = placementRs.rows
      .filter((r) => Number(r.slotIndex ?? r.slotindex) >= 1 && Number(r.slotIndex ?? r.slotindex) <= 10 && (r.instanceId ?? r.instanceid))
      .map((r) => byId.get(r.instanceId ?? r.instanceid))
      .filter(Boolean);
    const currentAddonRow = placementRs.rows.find((r) => Number(r.slotIndex ?? r.slotindex) === 0 && (r.instanceId ?? r.instanceid));
    const currentAddon = currentAddonRow ? byId.get(currentAddonRow.instanceId ?? currentAddonRow.instanceid) : null;

    const seeds = [];
    if (currentSlots.length === 10) seeds.push({ slotInsts: currentSlots, addonInst: currentAddon ?? sortedAddon[0] });
    seeds.push({ slotInsts: sortedGold.slice(0, 10), addonInst: sortedAddon[0] });
    seeds.push({ slotInsts: sortedGold.slice(0, 8).concat(sortedGold.slice(15, 17)), addonInst: sortedAddon[0] });
    for (let i = 0; i < 18; i += 1) {
      const slotInsts = sampleUnique(goldPool, 10);
      const used = new Set(slotInsts.map((s) => s.id));
      const addonInst = sortedAddon.find((a) => !used.has(a.id)) ?? sortedAddon[0];
      seeds.push({ slotInsts, addonInst });
    }

    let best = null;
    let idx = 0;
    for (const seed of seeds) {
      idx += 1;
      const candidate = localOptimize(USER_ID, state, seed.slotInsts, seed.addonInst, goldPool, addonPool, 10);
      if (!best || candidate.metrics.estimatedYieldPerHour > best.metrics.estimatedYieldPerHour + 1e-9) {
        best = candidate;
      }
      if (idx % 5 === 0) {
        console.error(`[seed ${idx}/${seeds.length}] best=${best.metrics.estimatedYieldPerHour.toFixed(6)}`);
      }
    }

    const addonRefined = pickBestAddon(USER_ID, state, best.slotInsts, addonPool, best.addonInst);
    best.addonInst = addonRefined.addon;
    best.metrics = addonRefined.metrics;

    const slotRows = best.slotInsts.map((inst, i) => ({
      slotIndex: i + 1,
      instanceId: inst.id,
      cardId: inst.cardId,
      title: inst.card.title,
      rarity: inst.card.rarity,
      pageId: inst.card.pageId,
      affixSignature: inst.affixSignature,
      authorTags: (inst.card.tags || []).filter((t) => String(t).startsWith('author:')).slice(0, 4)
    }));

    const authorFreq = new Map();
    for (const s of slotRows) {
      for (const t of s.authorTags) {
        authorFreq.set(t, (authorFreq.get(t) ?? 0) + 1);
      }
    }

    console.log(JSON.stringify({
      userId: USER_ID,
      attributionMode: 'AUTHOR+TRANSLATOR, fallback SUBMITTER',
      candidateSummary: {
        totalAvailableInstances: allInstances.length,
        goldPool: goldPool.length,
        addonPool: addonPool.length,
        pagesWithAuthorKeys: [...authorKeysByPage.keys()].length,
        seeds: seeds.length
      },
      metrics: best.metrics,
      comboBonuses: best.metrics.comboBonuses,
      topAuthorTagsInPlan: [...authorFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      slots: slotRows,
      addon: best.addonInst ? {
        slotIndex: 0,
        instanceId: best.addonInst.id,
        cardId: best.addonInst.cardId,
        title: best.addonInst.card.title,
        rarity: best.addonInst.card.rarity,
        pageId: best.addonInst.card.pageId,
        affixSignature: best.addonInst.affixSignature,
        authorTags: (best.addonInst.card.tags || []).filter((t) => String(t).startsWith('author:')).slice(0, 4)
      } : null,
      hints: {
        setPayloads: slotRows.map((s) => ({ slotIndex: s.slotIndex, cardId: s.cardId, affixSignature: s.affixSignature })),
        addonPayload: best.addonInst ? { cardId: best.addonInst.cardId, affixSignature: best.addonInst.affixSignature } : null
      }
    }, null, 2));
  } finally {
    await userDb.end();
    await coreDb.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
