export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  constructor(private readonly ratePerSec: number, private readonly burst = 1) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }
  private refill() {
    const now = Date.now();
    const add = ((now - this.lastRefill) / 1000) * this.ratePerSec;
    this.tokens = Math.min(this.burst, this.tokens + add);
    this.lastRefill = now;
  }
  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }
}


