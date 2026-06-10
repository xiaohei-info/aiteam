# P01 Login And Enterprise Onboarding Design

> Scope: `docs/实施计划/验收规格包/2026-06-06-AI-Team-P01-登录与企业入户验收规格.md`
> Confirmed approach: `mock-first`, only close P01 gaps, no real WeChat/SMS provider integration in this iteration.

## 1. Goal

Close the remaining P01 acceptance gaps on top of current `master`-equivalent code by aligning the login page and post-login enterprise entrance flow with the PRD and the frozen auth/onboarding contract.

This iteration must deliver:

- A PRD-aligned login primary experience with WeChat QR as the default entry and phone verification as the secondary entry
- A complete post-login enterprise onboarding path for users without a current enterprise
- Verifiable session continuity, cooldown, expiry, refresh, and common failure recovery behavior

This iteration must not expand into unrelated enterprise settings or system-admin governance work.

## 2. Current-State Findings

### 2.1 What already exists

- `app/team_panel/api_team/router_auth.py` already exposes mock-first northbound routes for:
  - `POST /api/auth/login/wechat/init`
  - `GET /api/auth/login/wechat/poll`
  - `POST /api/auth/login/wechat/callback`
  - `POST /api/auth/login/phone/send-code`
  - `POST /api/auth/login/phone/verify`
  - `POST /api/auth/refresh`
  - `POST /api/auth/logout`
  - `GET /api/me`
- `GET /api/me` already returns `current_enterprise`, `enterprises`, and `onboarding.action=create_or_join_enterprise` when the user has no current enterprise.
- Existing tests already cover core auth mock flows, refresh rotation, logout, IP cooldown, and login-page contract basics.

### 2.2 Real gaps

- `/login` still presents old password/passkey fallback UI inside the primary page shell, which does not match the P01 PRD as the main experience.
- The northbound contract required for enterprise entrance is missing:
  - `POST /api/auth/onboarding/create-enterprise`
  - `POST /api/auth/onboarding/join-enterprise`
  - `GET /api/enterprises/current`
- New users currently stop at `workbench?onboarding=create_or_join_enterprise` without a real enterprise creation/join completion path.
- Failure recovery for onboarding-specific cases such as invalid invite codes is not yet closed.

## 3. Scope And Boundaries

### 3.1 In scope

- `P01-F01` login page structure and default entry
- `P01-F02` QR and phone dual-entry lifecycle feedback
- `P01-F03` session safety behavior already modeled by the existing auth mock routes, plus any minimal frontend alignment needed to surface it correctly
- `P01-F04` first enterprise creation / invite-code join flow and successful entry into enterprise workspace
- `P01-F05` common login and onboarding failures with explicit recovery paths

### 3.2 Out of scope

- Real WeChat OAuth or real SMS provider integration
- A full enterprise chooser page for multi-enterprise users
- B08 enterprise settings invite governance UI
- S01 system-admin account/invite governance
- Mobile login implementation

### 3.3 Compatibility rules

- Existing auth mock routes remain provider-neutral and backward-compatible.
- Password/passkey compatibility logic may remain in code as a hidden fallback, but it must no longer be the main visual or interaction path for P01.
- No new role enum, no new shared state enum, and no change to the frozen auth/session contract beyond implementing missing required endpoints.

## 4. Functional Design

### 4.1 Login page primary experience

The `/login` page becomes a P01-first experience:

- Default visible tab is `WeChat QR`
- Page load automatically requests a QR code
- User sees explicit QR lifecycle feedback:
  - preparing
  - pending
  - scanned
  - confirmed
  - expired
- User can refresh an expired QR code without reloading the page
- Secondary tab is `Phone code`
- Phone path supports:
  - send code
  - 60-second resend cooldown
  - 5-minute code validity
  - success and failure messages

The page keeps agreement copy and entry guidance aligned with the PRD prototype.

### 4.2 Post-login routing decision

Frontend routing after login must depend on `/api/me`, not token inspection.

Decision rules:

1. If `current_enterprise` exists, redirect to `/app/workbench`
2. If `current_enterprise` is missing and `onboarding.action=create_or_join_enterprise`, route into onboarding completion UI
3. If current enterprise lookup later fails, return the user to the onboarding completion UI with a clear recovery path

### 4.3 Onboarding completion UI

Add a minimal onboarding completion surface for users who have successfully authenticated but do not yet have an active enterprise context.

The UI must provide two actions:

- Create enterprise
- Join enterprise by invite code

Create-enterprise flow:

- Input enterprise name
- Optional slug handling stays backend-controlled
- On success, redirect to `/app/workbench`

Join-enterprise flow:

- Input invite code
- On success, redirect to `/app/workbench`
- On invalid or expired invite code, show a clear inline error and stay recoverable

This UI should remain minimal and product-facing, not a generic admin settings page.

## 5. API Design

### 5.1 `POST /api/auth/onboarding/create-enterprise`

Request:

```json
{
  "name": "Acme AI Lab",
  "slug": "acme-ai-lab"
}
```

Behavior:

- Create an enterprise record
- Create owner membership for the authenticated user
- Update the session/profile view so `/api/me` returns the new `current_enterprise`
- Return `201` with enterprise summary

Response:

```json
{
  "enterprise_id": "ent_001",
  "name": "Acme AI Lab",
  "slug": "acme-ai-lab",
  "role": "owner"
}
```

### 5.2 `POST /api/auth/onboarding/join-enterprise`

Request:

```json
{
  "invite_code": "INV-abc123"
}
```

Behavior:

- Validate invite code
- Add membership for the authenticated user if allowed
- Update the session/profile view so `/api/me` returns the joined `current_enterprise`
- Return enterprise summary

Responses:

- `200` success
- `404` invalid or expired invite code
- `409` already a member of the target enterprise

### 5.3 `GET /api/enterprises/current`

Behavior:

- Return the current enterprise summary derived from the authenticated session/profile state
- If no current enterprise exists, return a clear not-found/empty result that the frontend can map back to onboarding recovery

## 6. Data Strategy

This iteration should favor the smallest stable implementation over new subsystem design.

### 6.1 Session/profile truth

`/api/me` remains the frontend truth source for:

- user identity
- current enterprise
- enterprise list
- onboarding action

Frontend must not infer these from access token payloads.

### 6.2 Enterprise creation

Enterprise creation should reuse existing enterprise and membership concepts already present in the Team Panel model, instead of inventing a parallel auth-only organization store.

### 6.3 Invite join

For invite-code join, prefer the smallest safe reusable invite representation already present in the repo. If the existing admin invite structure cannot be safely reused as-is for onboarding consumption, add only the minimal mock-first storage/state needed for P01 join flow instead of expanding B08 governance scope.

## 7. Error Handling

Required recoverable failure cases:

- QR code expired -> refresh action available
- QR flow timeout or callback failure -> user can restart from QR tab
- Phone code wrong or expired -> inline error, user can retry
- Phone resend during cooldown -> explicit cooldown message
- Invite code invalid or expired -> inline error, stay on join form
- Join target already linked -> explicit conflict message
- Create enterprise failure -> inline error, preserve entered values if possible
- Missing current enterprise after auth -> return user to onboarding completion UI instead of leaving them stuck in workbench

No failure path may require a full page refresh as the only recovery path.

## 8. Testing And Acceptance Evidence

### 8.1 Layer 2 backend tests

Add or update tests for:

- create-enterprise success
- join-enterprise success
- join-enterprise invalid invite
- join-enterprise duplicate membership
- current-enterprise lookup success and no-enterprise case
- `/api/me` reflection after onboarding completion

### 8.2 Layer 4 frontend/BFF tests

Add or update tests for:

- login page defaulting to QR tab
- auto-request QR on load
- QR refresh / expired messaging
- phone cooldown and resend behavior
- post-login routing into onboarding completion UI
- create-enterprise success path to workbench
- join-enterprise success path to workbench
- invalid invite recovery

### 8.3 Flow-level evidence

If the current test layout has a suitable higher-level flow harness, add one minimal end-to-end style flow proving:

- new user login
- onboarding completion
- enterprise workspace entry

### 8.4 Done evidence

P01 can only be considered closed for this iteration when there is evidence for:

- code changes
- automated test coverage for main paths and failure paths
- successful verification commands
- a final commit in the current worktree branch

## 9. Non-Goals And Tradeoffs

- This design intentionally does not solve every future multi-enterprise UX edge case.
- This design intentionally does not perform real provider integration.
- This design intentionally keeps onboarding completion small and self-contained rather than distributing special cases into workbench logic.

The tradeoff is deliberate: close the product path required by P01 first, then leave broader governance and provider work to their own lanes.
