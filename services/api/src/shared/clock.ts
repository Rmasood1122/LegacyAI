export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can move. Never used in production wiring. */
export class ManualClock implements Clock {
  #offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.#offsetMs);
  }
  advance(ms: number): void {
    this.#offsetMs += ms;
  }
  reset(): void {
    this.#offsetMs = 0;
  }
}
