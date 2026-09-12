export const MAX_RUNTIME_LEASE_TTL_MS = 300_000;
export const MAX_RUNTIME_LEASE_ENTRIES = 128;

/** Length-prefix each component so delimiters in tenant/member IDs cannot collide. */
export function encodeScope(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

export interface RuntimeLeaseCacheEntry<T> {
  key: string;
  value: T;
  loadedAt: number;
  expiresAt: number;
  ttlMs: number;
  loadedMonotonic: number;
  generation: number;
}

export interface RuntimeLeasePutOptions {
  now?: number;
  userJwtExpiresAt?: number;
  upstreamExpiresAt?: number;
  /** A short loaded-at bound is always applied, even if upstream grants more. */
  maxTtlMs?: number;
  loadedMonotonic?: number;
}

/**
 * Process-memory-only cache for already-authorized runtime material.
 *
 * No item is cached unless both user and upstream expiries are trusted.  The
 * cache never extends an expiry on a hit and uses a generation counter so an
 * in-flight response cleared by sign-out/revocation cannot repopulate it.
 */
export class RuntimeLeaseInvalidatedError extends Error {
  constructor(message = "Runtime lease load was invalidated") { super(message); this.name = "RuntimeLeaseInvalidatedError"; }
}

export class RuntimeLeaseCache<T> {
  private readonly entries = new Map<string, RuntimeLeaseCacheEntry<T>>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(private readonly options: { maxEntries?: number; maxTtlMs?: number; now?: () => number; monotonicNow?: () => number } = {}) {}

  get(key: string, now = this.clock()): RuntimeLeaseCacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.generation !== this.generation(key) || entry.expiresAt <= now || this.monotonic() - entry.loadedMonotonic >= entry.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  put(key: string, value: T, options: RuntimeLeasePutOptions): RuntimeLeaseCacheEntry<T> | undefined {
    const now = options.now ?? this.clock();
    const upstream = options.upstreamExpiresAt;
    const jwt = options.userJwtExpiresAt;
    // Missing either trust boundary means online-only material. It may still be
    // used by the current caller, but is deliberately not retained.
    if (!Number.isFinite(upstream) || !Number.isFinite(jwt)) return undefined;
    const ttl = boundedLeaseTtl(now, jwt, upstream, options.maxTtlMs ?? this.options.maxTtlMs);
    if (ttl === undefined) return undefined;
    const entry: RuntimeLeaseCacheEntry<T> = {
      key, value, loadedAt: now, expiresAt: now + ttl, ttlMs: ttl,
      loadedMonotonic: options.loadedMonotonic ?? this.monotonic(), generation: this.generation(key),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();
    return entry;
  }

  clear(key: string): void {
    this.entries.delete(key);
    // Detach the in-flight operation so a caller after revocation can start a
    // fresh load; the old operation still fails its generation check on return.
    this.pending.delete(key);
    this.generations.set(key, this.generation(key) + 1);
  }

  clearOwner(scope: string): void {
    const prefix = `${scope}|`;
    const keys = new Set([...this.entries.keys(), ...this.generations.keys(), ...this.pending.keys()]);
    for (const key of keys) {
      if (key !== scope && !key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.pending.delete(key);
      this.generations.set(key, this.generation(key) + 1);
    }
  }

  clearAll(): void {
    const keys = new Set([...this.generations.keys(), ...this.entries.keys(), ...this.pending.keys()]);
    this.entries.clear();
    this.pending.clear();
    for (const key of keys) this.generations.set(key, this.generation(key) + 1);
  }

  size(): number { return this.entries.size; }

  async getOrLoad(
    key: string,
    loader: () => Promise<T>,
    putOptions: (value: T, loadedAt: number) => RuntimeLeasePutOptions,
    options: {
      allowReuseOnFailure?: boolean;
      forceRefresh?: boolean;
      isDenial?: (error: unknown) => boolean;
      isRetryableFailure?: (error: unknown) => boolean;
    } = {},
  ): Promise<T> {
    const cached = this.get(key);
    if (cached && !options.forceRefresh) return cached.value;
    const fallback = cached?.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation(key);
    const loadedAt = this.clock();
    const loadedMonotonic = this.monotonic();
    const operation = (async () => {
      try {
        return await loader();
      } catch (error) {
        const denial = options.isDenial?.(error) === true;
        if (denial) {
          this.clear(key);
          throw error;
        }
        if (this.generation(key) !== generation) throw new RuntimeLeaseInvalidatedError();
        if (options.allowReuseOnFailure && (!options.isRetryableFailure || options.isRetryableFailure(error))) {
          if (fallback !== undefined) return fallback;
          const current = this.get(key);
          if (current) return current.value;
        }
        throw error;
      }
    })();
    this.pending.set(key, operation);
    try {
      const value = await operation;
      // Generation changes (sign-out/revoke) invalidate the response even if
      // the network request completed after the caller was cleared.
      if (this.generation(key) !== generation) throw new RuntimeLeaseInvalidatedError();
      this.put(key, value, { ...putOptions(value, loadedAt), loadedMonotonic });
      return value;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }

  private evict(): void {
    const max = Math.min(Math.max(this.options.maxEntries ?? MAX_RUNTIME_LEASE_ENTRIES, 1), MAX_RUNTIME_LEASE_ENTRIES);
    while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value as string);
  }

  private generation(key: string): number { return this.generations.get(key) ?? 0; }
  private clock(): number { return this.options.now?.() ?? Date.now(); }
  private monotonic(): number { return this.options.monotonicNow?.() ?? Number(process.hrtime.bigint()) / 1_000_000; }
}

export function boundedLeaseTtl(now: number, userJwtExpiresAt?: number, upstreamExpiresAt?: number, maxTtlMs = MAX_RUNTIME_LEASE_TTL_MS): number | undefined {
  if (!Number.isFinite(now) || !Number.isFinite(userJwtExpiresAt) || !Number.isFinite(upstreamExpiresAt)) return undefined;
  const ttl = Math.min(Math.max(maxTtlMs, 1), MAX_RUNTIME_LEASE_TTL_MS, userJwtExpiresAt! - now, upstreamExpiresAt! - now);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : undefined;
}

export function expiryMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1_000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
