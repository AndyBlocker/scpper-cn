// src/core/scheduler/BackoffManager.js
import { Logger } from '../../utils/Logger.js';

export class BackoffManager {
  /**
   * 普通 sleep（毫秒）
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 带日志的等待（秒）- 专用于 429 错误
   */
  async wait(seconds) {
    Logger.warn(`Rate limited. Waiting ${seconds}s before retry...`);
    await this.sleep(seconds * 1000);
    Logger.info('Resuming requests...');
  }
}
