/**
 * Manager-calibrated wall clock.
 *
 * Manager stamps `iat`/`exp` with its own clock, while the Agent runs on a user machine whose clock may
 * be minutes off (typical on Windows without time sync). Every Manager HTTP response carries a standard
 * `Date` header; we turn it into an offset so token time claims are compared in Manager time instead of
 * local time. Manager's `/api/auth/session` stays the authority for revocation and expiry.
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
