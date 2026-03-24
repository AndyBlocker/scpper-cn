import { Router } from 'express';
import fs from 'node:fs/promises';
import fsSyncForInit from 'node:fs';
import path from 'node:path';

const DATA_DIR = (() => {
  const candidates = [
    process.env.TEXT_ANALYSIS_DATA_DIR,
    path.resolve(process.cwd(), 'data/text-analysis'),
    path.resolve(process.cwd(), 'bff/data/text-analysis')
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fsSyncForInit.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || path.resolve(process.cwd(), 'data/text-analysis');
})();

// In-memory cache: { data, loadedAt }
const cache = new Map<string, { data: any; loadedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function loadJSON(filename: string): Promise<any> {
  const key = filename;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && (now - cached.loadedAt) < CACHE_TTL_MS) {
    return cached.data;
  }

  const filePath = path.join(DATA_DIR, filename);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    cache.set(key, { data, loadedAt: now });
    return data;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function jsonEndpoint(filename: string) {
  return async (_req: any, res: any, next: any) => {
    try {
      const data = await loadJSON(filename);
      if (data === null) {
        return res.status(404).json({ error: 'data_not_generated', message: `${filename} not found. Run the text-analysis pipeline first.` });
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  };
}

function paginatedEndpoint(filename: string, defaultLimit = 100) {
  return async (req: any, res: any, next: any) => {
    try {
      const data = await loadJSON(filename);
      if (data === null) {
        return res.status(404).json({ error: 'data_not_generated' });
      }

      const items: any[] = Array.isArray(data) ? data : (data.items || data.points || []);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || defaultLimit, 1), 500);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);

      res.json({
        items: items.slice(offset, offset + limit),
        total: items.length,
        limit,
        offset
      });
    } catch (err) {
      next(err);
    }
  };
}

export function textAnalysisRouter() {
  const router = Router();

  // Meta endpoint
  router.get('/meta', jsonEndpoint('meta.json'));

  // #1 Vocabulary Scatter (PMI×Entropy)
  router.get('/vocabulary-scatter', paginatedEndpoint('vocabulary-scatter.json', 200));

  // #2 Zipf Deviation
  router.get('/zipf-analysis', jsonEndpoint('zipf-analysis.json'));

  // #3 Vocabulary Evolution
  router.get('/vocabulary-evolution', jsonEndpoint('vocabulary-evolution.json'));

  // #4 Author Fingerprints
  router.get('/author-fingerprints', paginatedEndpoint('author-fingerprints.json', 50));

  // #5 Author Similarity Network
  router.get('/author-similarity', jsonEndpoint('author-similarity.json'));

  // #6 Quality Richness
  router.get('/quality-richness', paginatedEndpoint('quality-richness.json', 200));

  // #7 Creativity Ranking
  router.get('/creativity-ranking', paginatedEndpoint('creativity-ranking.json', 100));

  // #8 Cooccurrence Network
  router.get('/cooccurrence-network', jsonEndpoint('cooccurrence-network.json'));

  // #9 Tag Vocabulary Heatmap
  router.get('/tag-vocabulary-heatmap', jsonEndpoint('tag-vocabulary-heatmap.json'));

  // #10 Intertextuality Network
  router.get('/intertextuality-network', jsonEndpoint('intertextuality-network.json'));

  // #11 Dialect Comparison
  router.get('/dialect-comparison', jsonEndpoint('dialect-comparison.json'));

  // #12 Meme Word Spread
  router.get('/meme-word-spread', jsonEndpoint('meme-word-spread.json'));

  // #13 Emotion Temperature
  router.get('/emotion-temperature', jsonEndpoint('emotion-temperature.json'));

  return router;
}
