// Refill continuously and allow a bounded burst, so messages buffered by FRP
// do not all count against a single fixed one-second window.
export class TokenBucket {
  private tokens: number;
  private updated = performance.now();
  constructor(private perSecond: number, private capacity: number) { this.tokens = capacity; }
  take(now = performance.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updated) * this.perSecond / 1000);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens--; return true;
  }
}

export const POINTER_SEND_INTERVAL = 1000 / 60;
