import { PrismaClient } from '@prisma/client';
import { computePlacementMetrics } from './src/routes/gacha/_helpers.ts';

const prisma = new PrismaClient();
const userId = 'cmgefehmh0003epu3atyfn35z';

const BASE_BY_RARITY = { WHITE: 0.5, GREEN: 0.7, BLUE: 1.0, PURPLE: 1.5, GOLD: 2.0 };

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

function buildSlots(slotInsts) {
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

function buildAddons(addonInst) {
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

function evaluate(slotInsts, addonInst, stateObj) {
  return computePlacementMetrics(userId, stateObj, buildSlots(slotInsts), buildAddons(addonInst));
}

function pickBestAddon(slotInsts, addonPool, stateObj, currentAddon) {
  const used = new Set(slotInsts.map((s) => s.id));
  let bestAddon = currentAddon;
  let bestMetrics = evaluate(slotInsts, currentAddon, stateObj);
  for (const cand of addonPool) {
    if (used.has(cand.id)) continue;
    const metrics = evaluate(slotInsts, cand, stateObj);
    if (metrics.estimatedYieldPerHour > bestMetrics.estimatedYieldPerHour + 1e-9) {
      bestMetrics = metrics;
      bestAddon = cand;
    }
  }
  return { addon: bestAddon, metrics: bestMetrics };
}

function localOptimize(slotInstsInit, addonInit, slotPool, addonPool, stateObj, maxPasses = 8) {
  let slotInsts = [...slotInstsInit];
  let addonInst = addonInit;

  let addonPick = pickBestAddon(slotInsts, addonPool, stateObj, addonInst);
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
        const metrics = evaluate(slotInsts, addonInst, stateObj);
        if (metrics.estimatedYieldPerHour > bestLocal.estimatedYieldPerHour + 1e-9) {
          bestLocal = metrics;
          bestCand = cand;
        }
      }
      slotInsts[idx] = bestCand;
      used.add(bestCand.id);

      if (bestCand.id !== current.id) {
        improved = true;
        bestMetrics = bestLocal;
      }
    }

    addonPick = pickBestAddon(slotInsts, addonPool, stateObj, addonInst);
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

(async () => {
  const placementState = await prisma.gachaPlacementState.findUnique({ where: { userId } });
  if (!placementState) throw new Error('No placement state');

  const currentPlacementRows = await prisma.gachaPlacementSlot.findMany({ where: { userId }, orderBy: { slotIndex: 'asc' } });

  const all = await prisma.gachaCardInstance.findMany({
    where: { userId, tradeListingId: null, buyRequestId: null },
    include: { card: true }
  });

  const allInstances = all.map((inst) => ({
    ...inst,
    affixSignature: String(inst.affixSignature || 'NONE').toUpperCase(),
    styles: parseStyles(inst.affixSignature)
  }));

  const goldPool = allInstances.filter((inst) => inst.card.rarity === 'GOLD');
  const addonPool = allInstances.filter((inst) => inst.styles.includes('COLORLESS'));

  const sortedGold = [...goldPool].sort((a, b) => instanceHeuristic(b) - instanceHeuristic(a));
  const sortedAddon = [...addonPool].sort((a, b) => instanceHeuristic(b) - instanceHeuristic(a));

  const currentSlots = currentPlacementRows
    .filter((r) => r.slotIndex >= 1 && r.slotIndex <= 10 && r.instanceId)
    .map((r) => allInstances.find((x) => x.id === r.instanceId))
    .filter(Boolean);
  const currentAddonRow = currentPlacementRows.find((r) => r.slotIndex === 0 && r.instanceId);
  const currentAddonInst = currentAddonRow ? allInstances.find((x) => x.id === currentAddonRow.instanceId) : null;

  const seeds = [];
  if (currentSlots.length === 10) seeds.push({ slotInsts: currentSlots, addonInst: currentAddonInst ?? sortedAddon[0] });
  seeds.push({ slotInsts: sortedGold.slice(0, 10), addonInst: sortedAddon[0] });
  seeds.push({ slotInsts: sortedGold.slice(0, 8).concat(sortedGold.slice(15, 17)), addonInst: sortedAddon[0] });
  for (let i = 0; i < 12; i += 1) {
    const slotInsts = sampleUnique(goldPool, 10);
    const used = new Set(slotInsts.map((s) => s.id));
    const addonInst = sortedAddon.find((a) => !used.has(a.id)) ?? sortedAddon[0];
    seeds.push({ slotInsts, addonInst });
  }

  let best = null;
  let seedIdx = 0;
  for (const seed of seeds) {
    seedIdx += 1;
    const optimized = localOptimize(seed.slotInsts, seed.addonInst, goldPool, addonPool, placementState, 8);
    if (!best || optimized.metrics.estimatedYieldPerHour > best.metrics.estimatedYieldPerHour + 1e-9) {
      best = optimized;
    }
    if (seedIdx % 4 === 0) {
      console.error(`[seed ${seedIdx}/${seeds.length}] best=${best.metrics.estimatedYieldPerHour.toFixed(6)}`);
    }
  }

  // One global single-swap pass (full inventory)
  for (let idx = 0; idx < best.slotInsts.length; idx += 1) {
    const used = new Set(best.slotInsts.map((s) => s.id));
    if (best.addonInst) used.add(best.addonInst.id);
    const current = best.slotInsts[idx];
    used.delete(current.id);

    let localBestMetrics = best.metrics;
    let localBestInst = current;
    for (const cand of allInstances) {
      if (used.has(cand.id)) continue;
      best.slotInsts[idx] = cand;
      const metrics = evaluate(best.slotInsts, best.addonInst, placementState);
      if (metrics.estimatedYieldPerHour > localBestMetrics.estimatedYieldPerHour + 1e-9) {
        localBestMetrics = metrics;
        localBestInst = cand;
      }
    }
    best.slotInsts[idx] = localBestInst;
    best.metrics = localBestMetrics;
  }
  const addonRefine = pickBestAddon(best.slotInsts, addonPool, placementState, best.addonInst);
  best.addonInst = addonRefine.addon;
  best.metrics = addonRefine.metrics;

  const finalSlots = [...best.slotInsts].sort((a, b) => {
    if (a.card.rarity !== b.card.rarity) return String(b.card.rarity).localeCompare(String(a.card.rarity));
    if (a.card.title !== b.card.title) return a.card.title.localeCompare(b.card.title, 'zh-Hans-CN');
    return a.affixSignature.localeCompare(b.affixSignature);
  });

  console.log(JSON.stringify({
    userId,
    candidateSummary: {
      totalAvailableInstances: allInstances.length,
      goldPool: goldPool.length,
      addonPool: addonPool.length,
      seeds: seeds.length
    },
    metrics: best.metrics,
    comboBonuses: best.metrics.comboBonuses,
    slots: finalSlots.map((inst, idx) => ({
      slotIndex: idx + 1,
      instanceId: inst.id,
      cardId: inst.cardId,
      title: inst.card.title,
      rarity: inst.card.rarity,
      pageId: inst.card.pageId,
      affixSignature: inst.affixSignature
    })),
    addon: best.addonInst ? {
      slotIndex: 0,
      instanceId: best.addonInst.id,
      cardId: best.addonInst.cardId,
      title: best.addonInst.card.title,
      rarity: best.addonInst.card.rarity,
      pageId: best.addonInst.card.pageId,
      affixSignature: best.addonInst.affixSignature
    } : null,
    hints: {
      setPayloads: finalSlots.map((inst, idx) => ({ slotIndex: idx + 1, cardId: inst.cardId, affixSignature: inst.affixSignature })),
      addonPayload: best.addonInst ? { cardId: best.addonInst.cardId, affixSignature: best.addonInst.affixSignature } : null
    }
  }, null, 2));

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
