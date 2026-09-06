# Node Agent — controlled Manager memory consumer

This package hosts the pinned Pi runtime. Its Hindsight integration uses the
Manager facade, never a platform-wide Hindsight API key or a caller-selected
bank. This note describes the S04 consent compatibility contract; it is not a
claim that every v1 capability or finite-retention rollout has been completed.

## Negotiated memory permission

`HttpManagerClient.pullHindsightRuntimeConfig` always sends
`client_protocol: "aiteam-memory-v1"`, including explicit rotations. It does not
retry an authorization/upgrade/schema error as an old unnegotiated request.
Manager returns the confirmed protocol, exact allowed operations, a positive
policy revision and current `explicit_auto_retain` along with the short opaque
lease. Missing/invalid scope or consent cannot restore old permissions:

- Legacy responses are at most read-only to this consumer.
- A confirmed current lease must include versioned operation scope. Invalid
  consent values fail validation; missing consent is false.
- `agent_end` auto-retain is registered only when **both** the frozen snapshot
  and the current runtime lease explicitly permit automatic retention.
- The explicit retain tool still works when current policy permits manual retain
  but disables auto. A manual tool POST is not evidence of human approval; the
  separate S12 approval workflow owns that decision.
- Manager rechecks each call. A changed memory-policy revision denies the old
  lease's subsequent retain requests, even if recall/manual capability remains
  permitted in the new policy. Obtain new runtime material explicitly; do not
  replay rejected automatic content with a new bearer.

## Queues, reload and restart

The implementation reuses `@luxusai/pi-hindsight@0.12.0`'s queue and retry logic;
it does not create another memory store or execution engine. The SDK flushes its
configured queue on periodic ticks and shutdown. Manual retain also checks that
queue before sending its new item. Therefore a path shared across authorization
generations would let old automatic work borrow a fresh manual-only lease.

New queues use a `consent-v1` scope including tenant/member/employee/bank, policy
revision, lease ID/version and the effective auto-consent intersection. Generated
config and environment-key references are also lease-specific, so an older
lifecycle's config reload or shutdown cannot consume a replacement's key or
queue. Only the current loader's generated config is removed during shutdown;
raw lease tokens are never written into it.

**Pending queues from older/unknown leases are paused, not automatically adopted,
relabeled as manual, or silently deleted.** This also applies to old manual
pending content, and to 401/403 failures followed by renewal with the same policy
revision. Queue and dead-letter files keep their original jobs and operation
IDs. Restart must not restore a token or automatically attach those queues to a
new lease. There is no new replay/recovery API for old queues in this change.

Ordinary transient retry within the **same valid lease** continues through the
pinned SDK and preserves job identity. A later successful manual invocation
under a newly authorized lease writes only the new explicit item, not an old
pending queue. A request already handed off before revocation may have been
accepted natively; a denied response does not prove rollback or permit blind
replay. Manager's first accepted time/expiry must remain unchanged on retry.

## Focused verification

- `src/pi/hindsight-consent.test.ts` runs the actual pinned extension lifecycle,
  tool execution, queue files and periodic/shutdown retry against an isolated
  fetch transport. It covers current consent overriding stale snapshots,
  legacy/invalid runtime responses, old automatic/manual queues, reload isolation,
  401/403 non-replay and same-lease idempotency.
- `src/pi/resources.test.ts` and `src/manager-client.test.ts` cover resource/config
  isolation and the actual runtime-config request/normalization seam.
- Manager real-route/PG tests cover persisted protocol/revision enforcement.

## Fact-only recall and fresh authorization

Manager returns `retention_mode=fact_only` for finite or permanently guarded
banks, otherwise `unlimited`. The controlled pinned config uses only the exact
lease allowlist operations `recall` and/or `retain`: world/experience, no
observation preference or source-fact inclusion, and no mental-model injection
(the lease never grants that management operation). Manager independently
rechecks member/employee/grant, policy revision and lease expiry on every
facade call. Explicit unsupported derived options fail with
`memory_retention_option_unsupported`; they do not silently return cached/empty
successful results. Unlimited future retention does not clear an existing bank
guard, and a fresh authorized unlimited acceptance still requires source proof
in that bank.

Every controlled **context** recall uses a fresh instance of the pinned exported
`createRecallTurnPolicy`. Its parser, renderer and error handling are reused;
there is no local second implementation. The normal SDK lifecycle otherwise
keeps a 60-second cache keyed only by bank/message count, which cannot enforce a
Manager deadline or revocation. This adapter intentionally makes a new Manager
request even for immediate equal-length contexts and previously unlimited leases.

Only the Manager facade paths `GET .../profile`, `POST .../memories/recall`,
and `POST .../memories` are usable by this client; bank management and
PUT/PATCH/DELETE paths are never exposed. A missing or unknown protocol is
read-only (recall only), and a retain-only policy requires the current
`aiteam-memory-v1` negotiation rather than an old-request retry.

Only weak object identity is remembered for this loader's own context-only
injections. A later context removes those known old injections before resolving
new memory; it never deletes ordinary user messages by guessing from text tags.
Success adds fresh facts once. A 403, 503, expired result or unsupported mode
returns the original context without re-injecting old memory. No retained-body
cache, new store, SDK upgrade, model fallback or execution kernel is introduced.
Already delivered conversation text is not retroactively erased. Manual retain,
auto-consent checks and per-lease queue retry behavior above are unchanged.

`hindsight-consent.test.ts` executes these actual pinned context/tool consumers,
including immediate equal-count repetition, controlled expiry, old unlimited →
guarded rejection, 403/503, preserved user text and fresh fact injection. Optional
`AITEAM_S04_SDK_CONTRACT_OUT` writes only this test's synthetic request bodies to
an explicitly controlled artifact, allowing the Manager strict DTO/fact-only
parser to validate the actual serialized requests. It is not a production log
or memory store. Manager also has a separate real-route/PG/exact-native-image
integration gate (see its README). These local checks do not substitute for
independent review, CI, taiyi TEST or approval of historical first cleanup.

## Required Skill readiness (S05)

`/api/agent/grants/readiness` and `/api/agent/grants/experts/{employee_id}/readiness` now inspect each selected snapshot skill in the actual tenant/member cache, not an empty readiness array. A package must pass signing-key/TTL, envelope and file-hash verification **and** load through the pinned Pi Skill loader. Missing (`skill_missing`) or invalid/expired (`skill_invalid_or_expired`, `skill_invalid`) packages report `status=blocked` and make the expert unavailable. Versioned refs are retained in the cache's actual requested-version map. Another member's cache or a different version cannot satisfy a required ref.

The controlled resource loader also refuses a missing/unloadable required skill instead of silently omitting it; this check precedes Hindsight configuration materialization. Sync with Manager to install/repair the authorized package or refresh a valid signing-key cache. A Manager custom draft/invalid/disabled package is not executable. This is local cache readiness, not proof of remote RAG, Hindsight, connector or model connectivity, and does not replace those capabilities' separate authorization/lease enforcement.
