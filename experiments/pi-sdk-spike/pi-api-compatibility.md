# Pi SDK Compatibility Spike

- Package: `@earendil-works/pi-coding-agent`
- Locked version: `0.84.2`
- Node: `v22.23.2`
- Date: `2026-08-17`
- Status: first SDK/M1 slice passed; remaining Phase 0 integrations are explicitly pending.

## Verified

The disposable spike at `src/pi-sdk-spike.ts` verifies:

- `createAgentSession()` accepts a fully controlled `ResourceLoader` with no ambient extensions, skills, prompts, themes, or context files;
- `ModelRuntime.registerNativeProvider()` can host a deterministic test provider without network access;
- `SessionManager.create(cwd, sessionDir)` persists a JSONL Session;
- `SessionManager.open(sessionFile, sessionDir, cwd)` reopens the same Session and restores messages;
- `defineTool()`/`customTools` execute through the Pi Agent Loop;
- `message_update` text deltas, tool execution events, `agent_settled`, and `entry_appended` are available to the host;
- `AgentSession.abort()` interrupts a slow provider stream and returns the Session to idle;
- the Node Agent HTTP slice can expose prompt acceptance, SSE Pi events, Session entry reads, and Idempotency-Key conflict handling.

Run:

```bash
npm --prefix experiments/pi-sdk-spike run verify
npm --prefix server/agent_service run check
npm --prefix server/agent_service test
```

## API compatibility table

| Need | Public API validated | Result |
|---|---|---|
| Create/open a Session | `createAgentSession`, `SessionManager.create/open` | pass |
| Session content source | `SessionManager.getEntries`, `getLeafId`, `session.messages` | pass |
| Host event stream | `AgentSession.subscribe`, `AgentSessionEvent` | pass |
| Text streaming | `message_update` + `assistantMessageEvent.type === "text_delta"` | pass |
| Tool lifecycle | `tool_execution_start/update/end` | pass |
| Completion boundary | `agent_settled` | pass |
| Cancellation | `session.abort()` | pass |
| Controlled resources | `ResourceLoader` object + `createExtensionRuntime()` | pass |
| Custom business tools | `defineTool`, `customTools` | pass |
| Session replacement runtime | `createAgentSessionRuntime` rebinding | pending |
| Real provider/AI Relay | `ModelRuntime` credentials and provider override | pending |
| Production sandbox | external sandbox/custom tool routing | pending |
| Manager Hindsight facade | outside Pi SDK | pending |
| Child Session delegation | outside first private-chat slice | pending |

## Decisions from the spike

1. AI Team should use a process-level `ModelRuntime`, then create/open a Session per prompt in `SessionHost`.
2. The host must own and dispose session-local subscriptions; subscriptions are bound to one `AgentSession` instance.
3. Session file paths stay server-side. The HTTP API exposes entries/events, never the path.
4. The test provider is only a deterministic test/dev dependency. Production must select an authenticated model and must not silently fall back to Faux.
5. Node 22.23 exposes `node:sqlite` as an experimental built-in. The first Agent slice uses it to avoid a new native dependency; the production Node baseline must either pin this support or replace it with the chosen SQLite adapter before release.
6. Pi itself is not a sandbox. Coding tools remain blocked from production until the external sandbox/router is implemented and tested fail-closed.

## Pending M0 work

The spike intentionally does not claim the full Phase 0 contract. Before production cutover, add independent checks for:

- `AgentSessionRuntime` new/resume/fork/import rebinding;
- real provider/model credential and AI Relay configuration;
- sandbox routing and fail-closed startup;
- Manager knowledge artifact and Hindsight HTTP facade;
- `delegate_employee` child Session cancellation/partial failure;
- SQLite receipt lease recovery and schedule occurrence keys;
- SSE reconnect/replay using Pi entry IDs across process restart.
