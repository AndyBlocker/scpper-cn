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
    this._waiters = [];
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
    if (!task && this.active === 0) {
      const waiters = this._waiters;
      this._waiters = [];
      for (const w of waiters) w();
    }
  }

  async drain() {
    if (!this.queue.length && this.active === 0) return;
    await new Promise(resolve => this._waiters.push(resolve));
  }
}
