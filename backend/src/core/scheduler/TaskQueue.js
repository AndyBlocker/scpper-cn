// src/core/scheduler/TaskQueue.js
/**
 * 简易并发任务队列，默认串行（concurrency = 1）。
 * 可用于 Phase 3 并发抓取复杂页面。
 */
export class TaskQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
  }

  add(fn) {
    return new Promise((res, rej) => {
      const task = async () => {
        try {
          this.active++;
          const out = await fn();
          res(out);
        } catch (e) {
          rej(e);
        } finally {
          this.active--;
          this._next();
        }
      };
      this.queue.push(task);
      this._next();
    });
  }

  _next() {
    if (this.active >= this.concurrency) return;
    const task = this.queue.shift();
    if (task) task();
  }

  async drain() {
    while (this.queue.length || this.active) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
