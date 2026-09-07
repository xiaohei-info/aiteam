# Manager identity and configuration contracts

Manager is the online identity/configuration authority for one enterprise. Its
JWT signature verification remains local (`shared/auth`); the Manager-only
`ActivePrincipalVerifier` then reads the current account under `TenantContext` /
RLS and supplies current roles. Deleted or disabled principals cannot obtain new
password/Passkey/OAuth tokens, reset passwords, pull authorized configuration or
snapshots, obtain runtime credentials, or use an existing Hindsight lease online.
Agent offline JWT verification is unchanged: already-issued tokens remain valid
until expiry when checked locally. Browser **退出登录** clears only that browser's
session; it is not remote revocation of every issued JWT.

## One-enterprise deployment binding

Every real Manager deployment must set `MANAGER_TENANT_ID` to the explicitly
provisioned tenant UUID. The service never infers a tenant from the first or only
`tenant_registry` row. Public enterprise/account resolution, password login,
owner reset, JWKS, Operator tenant/bootstrap ingress, protected JWT verification,
and startup enterprise-space initialization all fail closed when this binding is
missing or does not exist in the registry. `healthz` remains a process liveness
check; `readyz` is 503 until the binding is present and validated. Dev/test fixtures
may inject a synthetic UUID explicitly. A body `tenant_id` never selects a second
enterprise on a bound deployment.

## Password and factor journeys

- Password login and `/api/auth/owner-reset` retain their paths. Reset is allowed
  for an active account with its current password. Typed 403 codes are
  `password_reset_required`, `password_expired`, and `principal_inactive`.
  Only the first two should offer password reset. Generic `forbidden` is not a
  first-login signal. New and reset password secrets receive a new timestamp;
  unknown historical password timestamps are not forcibly expired.
- `/settings` exposes the current user's Passkeys and OAuth connections to all
  active members. Enterprise settings/invitations and full employee configuration
  (including nested prompt/skill/knowledge/memory/connector configuration) require
  `owner` or `enterprise_admin`. `finance_admin` has no configuration exemption.
  Authorized member snapshot/RAG/runtime readers remain distinct from these
  administration APIs. Nested binding IDs must belong to the path employee.
- Removal is self-owned and must leave another login method. OAuth unlink removes
  both its connection and exact provider identity mappings atomically; it cannot
  be silently relinked by a later login. Other provider mappings remain intact.

### Trusted browser origin

Set **`MANAGER_PUBLIC_ORIGIN=https://manager.example.com`**, without a trailing
slash or path. This is separate from the JWT issuer and internal Manager URL.
Never derive it from a request Host/header/body. Production uses HTTPS.

Passkey RP ID is the configured DNS hostname; the ceremony validates the exact
origin, tenant/user challenge scope, credential allowlist, RP hash, user presence
and verification, signature, counter and one-time challenge. Development/tests
may explicitly use `AITEAM_ENV=test|dev` with `http://localhost:<port>`.
**IP addresses are not valid WebAuthn RP IDs**, even on loopback.

Missing/invalid Passkey configuration returns 503 `auth_origin_unconfigured` only
on Passkey ceremonies. Manager startup, health checks and password login do not
require this setting. OAuth applies its own trusted-origin validation; an HTTPS
IP origin does not become invalid merely because it cannot be a Passkey RP.
The current taiyi IP TEST entry cannot certify Passkey deployment: localhost
Chromium tests are real browser evidence, not production DNS/HTTPS acceptance.
A DNS+HTTPS origin must be approved/configured for that separate release check.
Previously created tenant-UUID RP credentials are not silently rebound to a new
RP; enroll a new credential from a working password/other account session.

### Existing OAuth API compatibility

Configured Google/GitHub adapters remain optional; no new SSO or refresh service
is introduced. Register the exact provider callback
`<MANAGER_PUBLIC_ORIGIN>/auth/oauth/callback`.

1. `POST /api/auth/oauth/authorize` accepts `provider`, `tenant_id`,
   `redirect_uri`, and additive `intent=login|link` (default login). `link` requires
   the current active user's JWT; the user is never selected by the body.
2. Store the returned state in the initiating browser's sessionStorage. This Web
   client checks its own transaction before sending any callback. State expires
   after ten minutes, is consumed atomically once, and is bound server-side to
   provider, tenant, intent, exact redirect and (for linking) user.
3. Login posts `provider/code/state` to `/api/auth/oauth/callback`. Linking posts
   `provider/code/state/redirect_uri` to `/api/manager/oauth/link` with the same
   user's JWT. **Old link requests missing state now return 422**; clients must
   upgrade rather than bypassing CSRF protection. A login state cannot link.
4. macOS composite clients can use the registered Manager browser callback;
   arbitrary native callback schemes are not implicitly trusted.

Challenge/state storage is process-local and TTL-bound, as in the existing
implementation: restarting a Manager invalidates incomplete ceremonies. No
refresh tokens or provider access tokens are persisted by this change.

## Effective revision and solution audience

Migration `0035_identity_and_employee_revision.sql` preserves every existing
employee version-trigger comparison and adds status. Lifecycle/no-op behavior:
`draft → active → paused → active → archived` each increments `employee.version`;
an unchanged status/configuration does not. `known_versions` still compares the
string form of that same version. Nonactive employees can still be read as
snapshots during sync so their updated status reaches Agent readiness; execution
credential issuance retains its separate active-employee gate. Already-loaded
in-flight snapshot objects are not mutated. When an authenticated scoped sync
supersedes a known-tenant employee's legacy `member_id=''` cache, Agent deletes
only that matching unscoped projection/snapshot in the existing SQLite metadata
transaction. Explicit revocation also removes that fallback. Other members'
scoped rows, other tenants, unknown-tenant rows and empty-delta entries are not
inferred or erased. A user relying only on an old member-less cache must sync
again; this compatibility does not preserve stale active authorization.

Solution apply extends reused employee grants by union; only explicit grant
management replaces/reduces audience. `RecruitTransaction` publishes local
employees, department assignments, grants, solution, orders and audit records in
one tenant/RLS transaction, after catalog preflight. An exception rolls back all
those writes, including edits to preexisting grants. Concurrent solution apply
is serialized within the enterprise and rechecks existing template instances.
An already-applied solution/version remains a 409 conflict (no duplicate rows),
not a new idempotent-success endpoint.

The same migration adds only DELETE permission on the existing
`passkey_credential` and `oauth_connection` RLS tables for their self-owned removal
routes. It does not broaden RLS, change ownership, grant ALL, or touch signing-key
privileges. Replaying it preserves data and revisions.

## Verification

The standard CI Manager suite includes real PG/RLS tests in
`test_auth_factors_pg.py`, `test_recruit_transaction.py`, and
`test_employee_effective_revision.py`. Unit tests exercise real services and
registered routes, synthetic ES256/CBOR ceremony validation, OAuth state scope,
and public-vs-internal configuration gates. `web/e2e/manager/account-security.spec.ts`
uses Chromium's virtual authenticator against real Manager routes/PG for
password login → enrollment → logout → Passkey login → removal. It requires an
isolated synthetic seed identity, not a real enterprise account.

## Enterprise RAG permission and citation contract (S03)

A Manager still owns **one enterprise workspace**. Unconfigured employees inherit
its default knowledge capability, subject to active member, employee lifecycle,
member grant, and the current employee tool allowlist. A nonempty `tools` list
permits only the listed operations: `knowledge_search` and `knowledge_get` are
independent. Legacy empty employee tools mean platform defaults, **not** an
escape hatch from a denied knowledge policy.

`KnowledgeAccessPolicy` is the effective resolver used by snapshots, authorized
configuration deltas, and actual Manager MCP calls. Each search/get reauthorizes;
search checks policy revision again after the external wait and before returning.
Unknown/conflicting document aliases, denied/deleted documents, and upstream
text not verifiable in the current allowed source are excluded. Graph summaries
are not trusted merely because they cite an allowed document. Versioned old
citations fail after reindex; document deny applies to legacy citations too.
Whole/tool denial produces 403 at the HTTP authorization boundary or an MCP tool
error for a disallowed operation in an otherwise authorized MCP session. Hidden,
deleted, or stale-version citation reads use the existing safe unavailable error.

### Administrator actions

These are current active `owner`/`enterprise_admin` actions, not member operations:

- Existing `/employees/{employee_id}/knowledge-bindings` POST and binding PATCH
  retain their paths. `enabled=false` explicitly denies the **whole knowledge
  capability**. PATCH omissions preserve enabled/config. DELETE now returns the
  existing 204 but retains an `enabled=false` tombstone, including server-derived
  actor/time/revision. GET/list continues to show that tombstone. Explicitly
  enabling it (or POSTing the same deleted reference) restores permission; delete
  never means “return to default.” Any observed whole deny takes priority.
- `GET /api/manager/employees/{employee_id}/knowledge-document-bindings` lists
  index rows and their separate permission metadata.
- `PUT .../knowledge-document-bindings/{document_id}` accepts **only**
  `{ "enabled": true|false }`. `DELETE` on that path is idempotent 204 and keeps a
  deny tombstone. Employee and document must exist in this enterprise. No caller
  workspace, actor, timestamp, or revision is accepted. These actions do not
  delete enterprise source files or LightRAG data.
- Document `enabled=null` is inheritance, not an administrator allow. An explicit
  document allow cannot override whole deny, current tools, or not-ready/deleted
  resource status. Only administrator policy writes change policy metadata;
  index/backfill/reindex/publish writes cannot reset it. Repeating the same PUT
  or DELETE is a no-op revision-wise. Policy changes increment existing
  `employee.version` in the same database transaction, so `known_versions` reaches
  the real Agent consumer without a second version namespace.

Snapshots and expert projections add `knowledge_policy` with `state`, exact
`allowed_operations`, and `revision`. **Empty allowed_operations explicitly denies
both knowledge tools.** The Agent preserves and enforces this projection,
including get-only access. Older clients must tolerate additive response fields;
Manager enforcement remains authoritative even for direct MCP clients or old
locally cached snapshots. In-flight local snapshot objects are not rewritten.

The Manager expert drawer shows effective whole/tool state and per-document
policy, with immediate writes separate from its general configuration save.
The enterprise knowledge page continues to manage document lifecycle for everyone.

### Migration and rollout safety

Apply `0036_knowledge_policy_tombstones.sql` before starting the updated service.
It adds metadata to existing RLS/FORCE tables and validates composite
enterprise/employee/document ownership FKs without deleting or repairing rows.
Whole observed disabled values remain denied; unknown historical actor/time
remain NULL. **Old document status `revoked` is not proof of administrator intent**:
it is also written by document deletion. Migration labels such rows
`legacy_resource` while preserving resource refusal, not permanent admin deny.
No-body `knowledge_policy_preflight.sql` is a read-only deployment check for
unknown whole-history ranges, resource-only status evidence and invalid owner
relationships. The deployment authority must review these results before TEST
upgrade. A missing whole binding could be untouched or historically physically
deleted; its intent cannot be reconstructed and is not silently changed. No real
enterprise preflight or historical-intent backfill was performed during S03.

Tests include real app_rw/RLS registered management routes, official MCP client,
negative/success authorization, metadata persistence after service/repository
recreation, all ready-publication/backfill paths preserving deny, citation version
checks, initial migration/replay and actual snapshot/delta consumers. LightRAG is
an isolated transport fixture here, not evidence of live deployment retrieval
quality. Independent review, CI and taiyi TEST rollout remain release gates.

## Hindsight consent and client compatibility (S04 recovery)

`employee_memory_setting` is the effective policy source. The existing setting
and employee-config writers preserve omitted policy fields and update its
revision plus the employee compatibility projection transactionally. An empty
operation list denies all operations; deleting a setting leaves a deny record.
Implicit legacy defaults are **not** automatic conversation-retention consent.
The policy catalog is only a template until explicitly applied.

The existing runtime-config route now negotiates the controlled memory client:

```json
{"employee_id":"<authorized-employee-id>","client_protocol":"aiteam-memory-v1"}
```

The returned opaque lease includes exact `allowed_operations` (only `recall` and
`retain`), `policy_revision`, Manager-confirmed `client_protocol`, current
`explicit_auto_retain`, and `retention_mode` (`unlimited` or `fact_only`). These
fields are part of the generated Manager OpenAPI response schema and are always
returned by the current route; `fact_only` means only provenance-verified
world/experience facts are exposed, not physical erasure. These are runtime
materials, not snapshot secrets. The Agent must intersect both snapshot and
current runtime permission. Missing runtime consent is false, never permission
to fall back to an older true. The protocol marker only negotiates supported
client behavior; it does not authenticate a binary, elevate member permissions,
prove a human click, or accept a model-supplied auto/manual label. S12 owns the
separate human approval gate for manual side effects.

The facade exposes only profile `GET`, recall `POST`, and retain `POST` under the
Manager-derived bank path. PUT/PATCH/DELETE, bank-management paths, unknown
query/body fields, encoded paths and over-limit bodies are denied. A missing or
unknown request protocol receives at most read-only recall; retain-only policy
returns `409 hindsight_client_upgrade_required` until a client sends
`client_protocol: "aiteam-memory-v1"`.

Compatibility rules:

- Missing/unknown request protocol receives only the currently allowed `recall`
  scope. If the policy only permits retain, the response is 409
  `hindsight_client_upgrade_required`. There is no legacy write bypass, even if
  an old Agent ignores new response fields and keeps auto-retaining.
- Schema migration `0037_memory_policy_lease_scopes.sql` adds nullable protocol
  evidence. Existing rows without it are **not** relabelled as supported. A
  scoped legacy lease can still recall under current authorization; it cannot
  retain. Rows without the older operation/revision evidence remain revoked.
- Every facade operation rechecks the active member, current roles/grant,
  employee lifecycle, effective policy and bank retention restrictions. Every
  retain also requires a supported lease protocol and an exact positive current
  policy revision. **Any memory-policy change invalidates the old write scope**,
  including cancellation of automatic retention while manual retain stays
  permitted. A freshly negotiated manual-only lease still supports the explicit
  retain tool. Explicit recall continues under the current intersection.
- Bank management is not a runtime privilege. Only exact profile GET, recall POST
  and retain POST are exposed. The trusted Manager provisions a missing bank;
  the SDK receives a sanitized successful profile instead of bank PUT permission.

The final Manager policy/lease check, after body reading and acceptance-metadata
preparation and immediately before native HTTP handoff, is the write authorization
fence. A policy change committed before that check blocks the write. A request
that already crossed the fence may have been accepted asynchronously by native
Hindsight: a later revocation or denied response **does not roll it back**. Do not
refresh the lease and automatically replay that request. Queue job identity and
Manager acceptance time/expiry must not be renewed by retry.

Upgrade Manager and controlled Agent consumers coherently. Old strict parsers
may reject the additive response; an old Manager may reject `client_protocol`.
Neither case is permission to retry without negotiation. macOS composite clients
using this Manager memory capability must follow the same protocol under the
proper member identity; ordinary SPAs remain same-tier.

## Finite retention and persistent bank protection (S04)

Finite retention now participates in actual Manager acceptance, recall and native
invalidation. Migration `0038_memory_retention_jobs.sql` stores only acceptance /
job metadata: employee/member/bank, immutable document generation, scoped native
operation ID, Manager `accepted_at`, deadline, revision, terminal evidence, claim
owner/expiry, retry and safe error code. Neither memory text, request payloads,
raw native responses nor tokens are copied to this ledger. Hindsight remains the
only long-term memory body store.

- The Manager database's acceptance time, **not** a caller's past/future timestamp,
  establishes retention. Retrying identical scoped input preserves operation,
  document generation and original acceptance/deadline. Different content gets a
  different document generation and cannot replace a caller-named document. An
  expired acceptance is denied even with a new authorized lease.
- Applying a shorter finite policy tightens outstanding deadlines in the policy
  transaction. Lengthening the policy, choosing unlimited, DELETE/recreate,
  another member or a Manager restart cannot extend or cancel an old deadline.
- A bank that has ever had an observed effective finite policy or trusted finite
  acceptance gets a durable **one-way bank guard**. Catalog templates alone do
  not activate it. All leases, including previously unlimited ones, obey it.
  Future unlimited acceptances can be read after native completion, but the bank
  remains ledger-proven **fact-only**. There is no guard-reset/rich-output escape
  hatch. Unknown historical sources are not adopted by matching a timestamp.
- Guarded recall returns only proven, current `id/text/type` facts of type
  `world` or `experience`. Pending, failed, expired, cleaned or unproven facts do
  not appear. Chunks, entities, observations, source facts, context, tags and
  metadata are not delivered as a hidden secondary channel. Explicit derived
  options get 403 `memory_retention_option_unsupported`, not a false empty success.
  Management list/edit/analytics apply the same protection; expired/unproven
  memories cannot be edited or reactivated, and native whole-bank statistics are
  omitted for guarded banks. In-flight policy changes prevent stale rich results.
- Native async success is an **acceptance**, not completion. The Manager lifespan
  reconciler polls `operations/{operation_id}?include_payload=false`, consuming
  the pinned response's **`operation_id`**, not an invented `id`. Terminal proof
  persists under the job's claim CAS independently of later cleanup failure.
  Expired completed jobs and terminal failed/cancelled partial jobs are invalidated
  in bounded pages of 100, always starting at offset zero. Pending/unknown/404
  operations never become guessed successes or cleanup authorizations.
- Claims expire after 60 seconds. A tick processes at most 16 documents, with
  bounded transport/work budgets, safe error metadata and exponential retry up
  to 300 seconds. Recreating the service resumes expired claims; an old owner
  cannot settle another worker's job or write through a lost claim. No-progress
  or partial invalidation is retried and never marked cleaned prematurely.
- The exact native 0.9.0 OpenAPI subset is fingerprinted (60-second positive
  cache). Unconfigured or incompatible native support returns 503
  `memory_retention_unverified` for guarded content abilities. This is not an
  operator-configurable bypass flag. The async transport also requires a valid
  acknowledgment and only returns safe acknowledgment fields.

### Meaning and rollout limits

**Invalidated is not physically erased.** The approved native proof shows shared
raw chunks can remain after fact invalidation; that is why the guard stays even
when future retention is relaxed. Previously delivered conversation/context text
cannot be taken back or scrubbed by this Manager policy. The controlled Agent
revalidates each new context recall rather than reusing the SDK's 60-second cache;
manual/auto-retain consent and lease-isolated queues are unchanged.

`memory_retention_preflight.historical_preflight` is a read-only, content-free
inventory of IDs/document hashes and known/unknown acceptance evidence, bounded
and explicitly marked `cleanup_authorized=false`. **No historical first cleanup
has been approved or performed.** Deployment authority must review a dry-run
before any historical adoption/invalidation. Unknown timestamps or a missing
operation are not reasons to clean automatically. Apply 0037/0038 coherently with
Manager and current controlled clients; a rollback must not restore older broad
lease permissions or remove existing guards/acceptance obligations.

### Reproducible local native integration gate

`test_memory_retention_native.py` connects actual Manager registered routes and
an isolated app_rw/RLS database to the exact already-approved native image. Only
embedding/ranking/model dependencies are doubles; native HTTP, SQL, async retain,
curation and recall are real. It does not read an ambient Hindsight URL or token.

1. Start the **approved local image only**, config ID
   `sha256:8d1952becd2119115e995accbdc7cdb88d9bc147df08653e0b47455ee08a0df0`,
   with `--pull=never --platform linux/amd64 --network none`, named
   `aiteam-s04-manager-native`, memory/CPU/PID limits. Bind only
   `scripts/verification/s04_hindsight_manager_fixture.py` read-only as
   `/tmp/s04_manager_fixture.py` and a new empty managed temporary directory as
   `/fixture`. Run `/app/api/.venv/bin/python /tmp/s04_manager_fixture.py`; set
   `HINDSIGHT_API_LOG_LEVEL=WARNING`, `HINDSIGHT_API_WORKER_ID=s04-fixture` and
   `LITELLM_LOCAL_MODEL_COST_MAP=True`. Do not mount a repository, home or secrets.
2. With explicit **synthetic fixture** `ADMIN_DB_URL`, app_rw `DB_URL` and
   `APP_RW_PASSWORD`, run `PYTHONPATH=server AITEAM_S04_NATIVE_CONTAINER=aiteam-s04-manager-native
   .venv/bin/pytest server/tests/manager/test_memory_retention_native.py`.
   Preserve the local Docker daemon endpoint explicitly when using an empty HOME;
   no credential helper or registry pull is required. Docker-exec bridges current
   request/response bytes to the container-local Unix HTTP socket, because macOS
   and Docker do not share a Unix socket kernel. No TCP port or external network
   is opened, and the bridge writes no body files.
3. Remove only that disposable native container and its temporary socket directory.
   The independent fixture PG is not a real enterprise database.

The local gate covers accepted time, real async completion, retry identity,
strict fact-only SDK-compatible output, management list/edit, expiry/revert
refusal, native invalidation and fresh unlimited acceptance in a guarded bank.
Additional fake-native/real-PG regressions inject 404, partial PATCH failure,
failed/cancelled operations, no progress, claim expiry, migration replay and
policy races. The full Manager/Agent/Web checks and these native results are
local implementation evidence, **not** independent review, CI or taiyi TEST
approval. Live upgrade, native worker process-loss recovery and authorized
historical inventories remain deployment/reviewer gates.

## S05: Custom Skill packages and durable knowledge intake

The existing `/api/manager/skills` POST and `/skills/{catalog_id}` PUT routes distinguish **metadata** from an **explicit complete package replacement**:

- Omitted PUT fields are preserved, including `version`, `files` and `content_hash`. A metadata-only edit does not clear or reconstruct executable bytes.
- A fileless creation is a `package_status=draft`, not an executable skill. Existing corrupt, unsigned-hash, unparseable or oversized packages are `invalid`; metadata edits preserve the original bytes. They are not distributed until explicitly repaired with a valid package/version.
- Explicit `files` must be a complete nonempty package with `SKILL.md`; at most 64 files / 1 MiB UTF-8 total, only canonical `SKILL.md` and `references/*.md` paths. Hashes are computed by Manager, and a supplied hash must agree. Empty replacement files are rejected, not interpreted as deletion.
- Custom `SKILL.md` requires a nonempty string `description` in YAML frontmatter. Validation uses pinned **PyYAML 6.0.3 safe_load**, with frontmatter <=8 KiB, depth/node/token bounds and no anchors, aliases, merges or duplicate keys. Plain/quoted/block/multiline/CRLF strings are supported; ambiguous YAML1.1 scalar types such as unquoted `yes` as a description are rejected (quote them). No code is executed during validation. Agent still checks the actual pinned Pi loader; YAML validation does not replace signature/path/hash verification.
- The same known skill ID/version cannot be reused for different bytes, including after deleting the catalog entry. Same bytes/version may be replayed. `skill_package_revision` stores only immutable fingerprints, not another package body store; it preserves only observable pre-upgrade hashes, not invented history. `catalog_version` remains the existing metadata revision counter. Operator-managed installs remain immutable through custom PUT/DELETE; use the platform market.
- Authorized sync signs only valid, enabled packages matching selected refs/versions. A required draft, invalid, missing or unavailable old version stays in the selected configuration but blocks Agent readiness/execution; it is never silently replaced by a different version.

Knowledge source bytes remain in the existing Manager storage root. Migration **0039** adds metadata-only claims/receipts to the existing ingestion jobs. New source document and job records are committed together. BackgroundTasks is now only a low-latency delivery hint: the Manager lifespan also scans immediately at startup and every five seconds, with at most eight claims per sweep. Each claim has an owner, heartbeat, 90-second expiry, CAS updates, attempts and bounded backoff (up to 300 seconds). API readiness does not require an upstream RAG connection.

Each new job uses its server-generated document/job correlation as `file_source`. Before the one LightRAG POST, Manager commits a submission fence; after receiving it, the server track ID is persisted immediately. Restart reconciles the track first, or the unique source in the fixed workspace when the track was lost. `processed` (or a duplicate's independently confirmed processed original) is required before an atomic document/job/binding-ready publication. A stale claimant cannot publish, and index publication does not alter S03 administrator deny/tombstone fields. Retry/reindex keeps the existing Idempotency-Key receipt and creates a new generation only after a safe terminal result.

### Unknown submissions: protected, not ordinary retryable failures

LightRAG 1.5.6 generates its own track ID; the text POST has no caller-supplied idempotent operation ID. A crash just after committing the fence—even before sending the POST—or after upstream acceptance but before recording the response cannot prove whether work was accepted. **Absence from a listing is not cancellation proof.** Manager never blindly resends these jobs.

After repeated unknown results the document reports `failed / SUBMISSION_UNKNOWN`, **`can_retry=false`, `can_delete=false`**, and mutations return 409 `knowledge_reconciliation_required`. The job remains claimable and automatically reconciles with bounded backoff, even in this failed display state. Pending/processing work likewise remains protected; a confirmed terminal failure or a genuinely pre-fence parse/configuration failure permits explicit retry/delete. The Web page keeps polling unknown jobs, shows “需对账”, and does not offer destructive/retry buttons. A delayed processed result can still recover the same job without a second POST.

For an unresolved case, collect the existing read-only document/ingestion endpoints' IDs, error code, attempts and next check time. With authorized deployment access, inspect **metadata only** in `knowledge_ingestion_job`: `id`, `tenant_id`, `document_id`, `status`, `submission_state`, `claim_owner`, `lease_until`, `heartbeat_at`, `attempts`, `next_attempt_at`, `file_source`, `track_id`, `upstream_document_id`. Confirm the configured workspace/instance and compare exact track/source IDs to bounded LightRAG status metadata. Do not log source text, remote response bodies or service keys. Legacy repeated jobs sharing one old document alias are deliberately not auto-adopted; mismatched/conflicting IDs or incomplete pagination remain unknown.

There is **no force-delete/reset escape hatch**. If the upstream cannot prove terminal/cancelled/no-inflight work, keep protection and request an explicitly reviewed operational reconciliation. Do not flip job state by hand merely because a list is empty. Migration adds a composite tenant/space/document FK and fails on inconsistent legacy ownership rather than repairing it implicitly. Coordinate restart/cutover so pre-S05 workers are stopped before enabling the new claims; do not run the old unclaimed ingestion writer alongside the new recovery worker. Production LightRAG restart/rollout validation and any real-data repair remain deployment-owner gates; synthetic restart tests are not taiyi delivery evidence.

The read-only inventory is `knowledge_intake_preflight.sql` (works both before and after 0039); execute it only against an explicitly authorized deployment in a read-only transaction. It lists metadata gaps, unknown/fenced counts, claim/correlation data and observable skill fingerprints without selecting bodies. The simplified TEST `deploy/ci/run.sh` maintenance path now stops application writers before checkout/build, explicitly starts and verifies PostgreSQL/NewAPI before backup and DDL/migration, then starts the new app stack; it is a full downtime window, not a zero-downtime or optional systemd cgroup probe. Require explicit TEST short-downtime approval for the concrete version/inventory. Rollback must retain fence-aware code/schema; restarting pre-S05 code or restoring only the DB cannot roll back LightRAG's accepted jobs.

### Reindex acceptance transaction

A new reindex now commits its Idempotency-Key receipt, document CAS/stale-index transition and exactly associated ingestion job **in the same TenantContext/RLS transaction**. The delivery hint runs only after commit. A failed CAS or any pre-commit error rolls back the receipt as well as the document/job changes. A lost response after commit is replayed using the same receipt and exact `operation_id`-linked job; startup can process that job even when no delivery hint ran. Same key with different fingerprint/document/space remains 409. A completed receipt never re-executes because its document subsequently changed.

Pending legacy receipts without a proven `operation_id` association return 409 `knowledge_reconciliation_required`; they are not attached to another generation by matching document ID. Ambiguous or inconsistent associations are also protected. The read-only preflight reports these unproven receipts; they require reviewed operational evidence, not an automatic replay. After delivery the response reads this exact generation's receipt rather than deriving or overwriting it from the document's possibly newer status. This correction adds no route, wire field, migration or data store.
