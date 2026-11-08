import type { AuthenticatedCaller } from "./http/auth.js";
import { encodeScope } from "./runtime-lease-cache.js";

export interface ExecutionIdentity {
  caller: AuthenticatedCaller;
  tenantId: string;
  memberId: string;
  expiresAt: number;
  generation: number;
}

export interface ExecutionAuthorizationOptions {
}

/**
 * Short-lived, in-process identity registry used by local background work.
 * It stores no password and never persists the bearer token. A scheduler must
 * request an identity with requireAccessToken=true before reserving a receipt.
 */
export class ExecutionAuthorizationRegistry {
  private readonly identities = new Map<string, ExecutionIdentity>();
  private readonly generations = new Map<string, number>();

  constructor(_options: ExecutionAuthorizationOptions = {}) {}

  register(caller: AuthenticatedCaller): ExecutionIdentity | undefined {
    if (!caller.tenantId || !(caller.userId ?? caller.callerId)) return undefined;
    const memberId = caller.userId ?? caller.callerId;
    const key = this.key(caller.tenantId, memberId);
    const identity: ExecutionIdentity = { caller, tenantId: caller.tenantId, memberId, expiresAt: Number.POSITIVE_INFINITY, generation: this.generation(key) };
    this.identities.set(key, identity);
    return identity;
  }

  resolve(tenantId: string, memberId: string, options: { requireAccessToken?: boolean } = {}): AuthenticatedCaller | undefined {
    const key = this.key(tenantId, memberId);
    const identity = this.identities.get(key);
    if (!identity || identity.generation !== this.generation(key)) {
      if (identity) this.identities.delete(key);
      return undefined;
    }
    if (options.requireAccessToken && !identity.caller.accessToken) return undefined;
    return identity.caller;
  }

  get(tenantId: string, memberId: string): ExecutionIdentity | undefined {
    const caller = this.resolve(tenantId, memberId);
    if (!caller) return undefined;
    return this.identities.get(this.key(tenantId, memberId));
  }

  invalidate(tenantId: string, memberId: string): void {
    const key = this.key(tenantId, memberId);
    this.identities.delete(key);
    this.generations.set(key, this.generation(key) + 1);
  }

  clear(): void {
    for (const key of this.identities.keys()) this.generations.set(key, this.generation(key) + 1);
    this.identities.clear();
  }

  private key(tenantId: string, memberId: string): string { return encodeScope([tenantId, memberId]); }
  private generation(key: string): number { return this.generations.get(key) ?? 0; }
}

export function callerMemberId(caller: AuthenticatedCaller): string {
  return caller.userId ?? caller.callerId;
}
