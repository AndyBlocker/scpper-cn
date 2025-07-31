// src/core/processors/ResumeManager.js
import { DataStore } from '../store/DataStore.js';

/**
 * 简单断点续传控制：根据 DataStore 中文件是否存在
 * 和已处理 URL 集，判断是否需要跳过。
 */
export class ResumeManager {
  constructor() {
    this.store = new DataStore();
  }

  async alreadyDone(phase, url) {
    const done = await this.store.loadProgress(phase);
    return done.some(p => p.wikidotInfo?.url === url);
  }
}
