// src/core/store/DataStore.js
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class DataStore {
  constructor(dir = '.cache') {
    this.dir = dir;
  }

  async loadProgress(phase = 'phase1') {
    try {
      const p = path.join(this.dir, `${phase}.jsonl`);
      const text = await fs.readFile(p, 'utf8');
      return text.split('\n').filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  }

  async append(phase, obj) {
    const p = path.join(this.dir, `${phase}.jsonl`);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(p, JSON.stringify(obj) + '\n');
  }
}
