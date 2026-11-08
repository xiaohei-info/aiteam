/**
 * Manager-calibrated wall clock.
 *
 * Manager-relative wall clock for local deadlines that explicitly need a shared
 * time basis. JWT validity and session revocation remain Manager-authoritative;
 * Agent authentication does not use this clock to reject absolute JWT claims.
 */

/** Offsets beyond this are not plausible calibration data; ignoring them keeps a bogus `Date` header harmless. */
export const MAX_CLOCK_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
/** A slow round trip makes the midpoint estimate meaningless. */
const MAX_OBSERVED_RTT_MS = 10_000;

export class ManagerClock {
  private offset = 0;

  /** Manager-aligned epoch milliseconds. Equals `Date.now()` until the first observation. */
  now(): number { return Date.now() + this.offset; }

  /** Manager time minus local time, in milliseconds. */
  get offsetMs(): number { return this.offset; }

  reset(): void { this.offset = 0; }

  /** Record one Manager response. `sentAt`/`receivedAt` are local `Date.now()` bracketing the request. */
  observe(headers: Headers, sentAt: number, receivedAt: number = Date.now()): void {
    const date = headers.get("date");
    if (!date) return;
    // A cached copy carries a stale Date; only an origin response says what time Manager has now.
    const age = Number(headers.get("age") ?? 0);
    if (Number.isFinite(age) && age > 0) return;
    const managerTime = Date.parse(date);
    const rtt = receivedAt - sentAt;
    if (!Number.isFinite(managerTime) || rtt < 0 || rtt > MAX_OBSERVED_RTT_MS) return;
    const offset = managerTime - (sentAt + rtt / 2);
    if (Math.abs(offset) > MAX_CLOCK_OFFSET_MS) return;
    this.offset = offset;
  }

  /** Wrap a fetch so every response calibrates the clock. */
  observingFetch(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      const sentAt = Date.now();
      const response = await fetchImpl(input, init);
      this.observe(response.headers, sentAt);
      return response;
    };
  }
}

export const managerClock = new ManagerClock();
