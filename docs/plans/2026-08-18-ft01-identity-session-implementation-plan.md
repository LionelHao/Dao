# FT-01 Identity & Session · Implementation Plan

> Date: 2026-08-18
> Status: implemented; final evidence recorded in the acceptance matrix and delivery note
> Product authority: [`2026-08-agent群聊协作模式-prd.reconstructed.md`](../reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)
> Acceptance authority: [`2026-08-18-ft01-identity-session-acceptance-matrix.md`](./2026-08-18-ft01-identity-session-acceptance-matrix.md)

## 1. Outcome and delivery claim

This increment closes the executable core of `REQ-ID-002` / `REQ-PRIM-002` and the Identity part of J-01:

1. a Human uses the existing scrypt-backed password identity adapter to authenticate against the real authoritative WebSocket server;
2. every login creates an independently addressable device session family;
3. an authenticated Human can list their active device sessions and revoke exactly one owned family;
4. revocation is durable, emitted through the existing identity outbox, terminates every live connection in the target family, and does not affect sibling device families;
5. Electron main owns WebSocket credentials and encrypted persistence; preload exposes a closed Identity API; renderer receives only sanitized public state;
6. startup restore, access refresh, logout, remote revocation, unavailable transport, and corrupt/unavailable credential storage are closed UI states;
7. automated tests and the delivery note provide reproducible evidence.

“Real login” in this increment means the implemented product path is Desktop renderer → preload/IPC → Electron main → WebSocket → SQLite Authority password authentication. Automated proof is deliberately layered: real SQLite/WS/controllers are exercised together; vault/runtime/IPC/preload/renderer are component-integrated; the built sandbox preload/renderer gets an Electron startup smoke. It is not presented as one packaged Electron-to-server test. Account provisioning is also not yet invitation-driven: the production composition still receives `PasswordIdentityRecord[]` through `IdentityAdapter`.

The final delivery may claim **FT-01 Identity/Session slice complete**, not **all FT-01 complete**. Invitation-bound account creation, Tenant Administrator governance, Global Agent Profile administration, encrypted Room cache, and offline read leases remain explicit shared work described in §4.

## 2. Baseline and constraints

### 2.1 Existing capabilities to preserve

- `AuthenticationService` already provides human-only login, scrypt verification, opaque access/refresh tokens, 15-minute/30-day defaults, refresh rotation, replay detection, and current-family revoke.
- production composition already uses worker-owned SQLite Authority rather than JSON session state;
- `sessions` stores token hashes, never bearer tokens;
- every protected WebSocket action revalidates the current access token;
- family revocation already creates a stable `identity.session.revoked` event and a `session-family` outbox delivery;
- `contextIsolation=true` and `nodeIntegration=false` already protect the Desktop renderer;
- existing static renderer review routes and `ClientSyncReplica` tests must remain working.

Baseline evidence before implementation:

```text
./node_modules/.bin/vitest run \
  packages/server/src/auth.test.ts \
  packages/server/src/websocket.test.ts \
  packages/desktop/src/window.test.ts \
  packages/desktop/src/renderer/app.test.ts

4 files passed; 159 tests passed
./node_modules/.bin/tsc -b --pretty false
passed
```

The repository starts with user-owned changes in `CONTEXT.md`, `docs/design/`, and `docs/reconstruction/`. This implementation must not rewrite or discard them.

### 2.2 Gaps this increment must close

- no family-level device metadata or stable public session ID;
- no list-owned-sessions authority operation;
- no atomic revoke-owned-target-family operation;
- no closed WebSocket request/ACK contract for list and targeted revoke;
- no Desktop WebSocket client, safe credential vault, controller, IPC handlers, preload bridge, or live auth renderer;
- no same-account/two-device automated proof;
- no delivery evidence tied to the approved FT-01 requirements.

### 2.3 Security invariants

1. The renderer never receives access token, refresh token, token hash, internal family ID, safe-storage ciphertext, or raw Electron IPC objects.
2. Passwords cross one closed login IPC call and one WebSocket login frame. They are never persisted, logged, included in errors, or returned.
3. A public session ID is independent from bearer credentials and is server-issued. It is an identifier, not an authority.
4. Targeted revoke validates the caller's current access session and target ownership in one AuthorityWorker transaction. UI hiding and a prior list result are not authorization.
5. Revoking family B changes no token or family belonging to A or C.
6. A refresh rotates token generations but preserves the public device-session identity.
7. Only loopback `ws://` is accepted. Non-loopback endpoints require `wss://`; renderer cannot choose the endpoint.
8. Credential encryption unavailable/corrupt means fail closed. There is no plaintext fallback.
9. A matching server ACK or terminal event, never successful callback return alone, advances the UI to success.
10. Existing command/query/subscribe/tool/session-family revalidation remains mandatory.
11. An account/Human principal has at most 96 active, unexpired device families. The server issuance limit, worker response guard, Desktop session-array guard, and 64 KiB auth frame budget are tested as one closed capacity contract.

## 3. Target architecture

```text
Renderer Identity UI
  public DTO + closed commands only
            │
            ▼
Preload contextBridge
  fixed method/channel allowlist
            │
            ▼
Electron main IdentitySessionController
  ├─ request-correlated WebSocket auth transport
  ├─ safeStorage-backed atomic credential vault
  ├─ persistent local device identity
  ├─ terminal revocation handling
  └─ public state broadcaster / cache-invalidation port
            │
            ▼
Authoritative WebSocket
  strict frames + per-action reauthentication
            │
            ▼
AuthenticationService / SessionAuthority
            │
            ▼
AuthorityWorker transaction
  session_families + token generations + identity event + outbox
```

### 3.1 Server data model

Add authority schema v12 table `session_families`:

| Column | Meaning |
| --- | --- |
| `family_id` | existing internal family routing ID; never returned to renderer |
| `public_id` | independently generated opaque public session ID, unique |
| `account_id` / `actor_id` | immutable Human principal binding |
| `device_id` | bounded installation identifier supplied as non-authoritative metadata |
| `device_label` | bounded user-facing device label |
| `platform` | `macos/windows/linux/unknown` display metadata |
| `created_at` | server clock timestamp; nullable only for migrated legacy families |
| `refresh_expires_at` | current family refresh horizon |
| `revoked_at` | family-level revocation state, distinct from token-generation rotation |

The existing `sessions` table remains one row per token generation. Its `revoked_at` continues to mean that generation cannot authenticate; `session_families.revoked_at` becomes the unambiguous device-family terminal state.

V12 migration backfills one family row per existing `sessions.family_id`, gives it an independent random opaque public ID and `Legacy device` metadata, derives the maximum refresh horizon, and marks the family revoked only if it has no unrevoked token generation. JSON legacy import uses a stable domain-separated digest because that format may be imported repeatedly. Neither form embeds the internal family ID. Schema validation must prove every session row has exactly one matching family/principal.

The existing closed identity event payload is not silently expanded. Device metadata remains in the family projection; issuance/rotation/revocation events keep their historical payload contract.

### 3.2 Public session projection

```ts
interface PublicSession {
  readonly id: string;
  readonly deviceLabel: string;
  readonly platform: "macos" | "windows" | "linux" | "unknown";
  readonly createdAt?: string;
  readonly refreshExpiresAt: string;
  readonly current: boolean;
}
```

The list contains active, non-expired families owned by the authenticated account/actor, in deterministic newest-first order. It contains no credential material or internal IDs.

When 96 active, unexpired families already exist, a successful password login atomically revokes the deterministic oldest family (`createdAt`, then public ID) and issues the replacement, keeping the total at 96 and avoiding a lost-all-devices recovery dead end. The SQLite path emits the normal terminal event/outbox in the same transaction. An anomalous legacy/mutated authority with more than 96 active families is rejected explicitly during migration/import and by list with 409 `session_limit_reached`; it is never silently truncated. This finite authority limit keeps every valid list within the Desktop parser/frame budget.

### 3.3 Wire contract

New client frames:

```ts
{ type: "auth.sessions.list"; requestId: string }
{ type: "auth.session.revoke"; requestId: string; sessionId: string }
```

`auth.login` gains a required closed `device` object for the new Desktop path, while the service API retains a bounded `unknown` default for legacy callers during migration:

```ts
{
  type: "auth.login";
  requestId: string;
  accountId: string;
  secret: string;
  device: { id: string; label: string; platform: "macos" | "windows" | "linux" | "unknown" };
}
```

New server frames:

```ts
{ type: "auth.sessions"; requestId: string; sessions: readonly PublicSession[] }
{ type: "auth.session.revoke.ack"; requestId: string; sessionId: string; revoked: true }
```

The existing unsolicited terminal frame remains:

```ts
{ type: "auth.session-revoked"; eventId: string }
```

The ACK means the targeted family revoke transaction committed. The terminal frame means a connection in that family must immediately stop, clear local credentials, lock/clear in-memory authorized state, and return to the revoked/login surface.

### 3.4 Desktop public contract

The preload bridge exposes one frozen `window.dao.identity` object:

```ts
getState(): Promise<IdentityPublicState>
login(input: { accountId: string; secret: string }): Promise<IdentityPublicState>
refreshSessions(): Promise<IdentityPublicState>
revokeSession(input: { sessionId: string }): Promise<IdentityPublicState>
logout(): Promise<IdentityPublicState>
onStateChanged(listener: (state: IdentityPublicState) => void): () => void
```

No generic `send`, `invoke`, channel string, filesystem, shell, endpoint, or token method is exposed.

Public startup states are closed:

- `starting`
- `signed-out`
- `authenticating`
- `restoring`
- `authenticated`
- `unavailable`
- `revoked`
- `fatal`

`authenticated` requires encrypted credentials to be durably stored first. `revoked` and logout clear credentials before the renderer is notified. `unavailable` retains encrypted credentials for an explicit retry; it never displays Room content because Room bootstrap is outside this increment.

## 4. Scope boundaries and requirement traceability

| Requirement | This increment | Explicit boundary |
| --- | --- | --- |
| REQ-ID-001 / PRIM-001 | Regression-protect human-only login and server-derived actor identity. | Message-author and Agent capability paths already exist; no redesign. |
| REQ-ID-002 / PRIM-002 | Complete real password login, independent device families, list, targeted revoke, Desktop reaction. | Core delivery claim. |
| REQ-ID-003 / PRIM-004 | Preserve Human invitation vs Agent configuration separation. | Invitation-bound account creation/acceptance UI remains FT-01 + FT-02/16 follow-up. |
| REQ-ID-004 / AGT-004 / NFR-006 | No privilege expansion; administrator cannot be inferred from a session. | Tenant Administrator, Global Profile, provider credential governance remain FT-01 + FT-07/14. |
| REQ-ID-005 / NFR-008 | Session revoke immediately stops server access and clears Desktop credentials/in-memory authorized state through an invalidation port. | Encrypted Room cache and finite offline lease require FT-13/14; no full cache-clear claim. |
| REQ-ROOM-004 / NFR-014 | Session revoke remains independent of Room archive state. | Room archive/reopen implementation belongs to FT-02/10/13. |
| REQ-AGT-012 | Existing tool confirmations remain bound to internal session family and fail after revoke. | New direct confirmation UI is outside this increment. |
| REQ-UX-006 | Implement auth startup/login/revoked/unavailable/fatal surfaces without unauthorized content flash. | Catalog/Room atomic repair and offline Room view belong to FT-11/13. |
| REQ-NFR-011 | Preserve server revalidation on every protected operation. | Full attachment/context/worker coverage remains in their owning FTs. |
| REQ-NFR-013 | Closed preload/IPC, sandboxed renderer, navigation/window denial. | Actual macOS packaging/notarization belongs to release work. |

## 5. TDD execution plan

Every task follows RED → minimal GREEN → focused regression → refactor. Tests are committed in the same change as their implementation; documentation never substitutes for a failing-then-passing automated assertion.

### Task 1 — Freeze domain, projection, and migration contracts

Files:

- modify `packages/server/src/persistence/schema.ts`
- modify `packages/server/src/persistence/schema.test.ts`
- modify `packages/server/src/persistence/legacy-importer.ts`
- modify `packages/server/src/persistence/legacy-importer.test.ts`
- modify `packages/server/src/persistence/contracts.ts`
- modify `packages/server/src/persistence/contracts.test.ts`

RED first:

1. fresh authority DB reports schema v12 and exact `session_families` columns;
2. v11 → v12 backfill preserves token rows and creates one closed family projection;
3. migration fault rolls back table, version, and migration record atomically;
4. invalid cross-principal or missing family rows fail schema validation;
5. legacy JSON import creates explainable legacy family metadata;
6. public projection type contains no token/hash fields.

GREEN:

- add immutable v12 migration/checksum/fingerprint/schema contract;
- add data invariants and legacy backfill/import;
- introduce `SessionDevice`, `PublicSession`, issue/list/revoke authority contracts;
- pass the same injected `now` through token expiry, family creation, and issuance event.

### Task 2 — Add closed worker protocol and atomic family authority

Files:

- modify `packages/server/src/persistence/worker-protocol.ts`
- modify `packages/server/src/persistence/worker-database-client.ts`
- modify `packages/server/src/persistence/worker-database-client.test.ts`
- modify `packages/server/src/persistence/authority-worker.ts`
- modify `packages/server/src/persistence/sqlite-authoritative-store.ts`
- modify `packages/server/src/persistence/sqlite-authoritative-store.test.ts`

RED first:

1. same principal/device A and B receive distinct public IDs and usable families;
2. list returns only caller-owned active families, marks current, and contains no secret/hash;
3. refresh retains public ID/device metadata and updates refresh horizon;
4. A revokes B: B access and refresh fail, A remains valid;
5. a different principal cannot discover or revoke B and causes zero mutation;
6. unknown target has stable non-leaking semantics;
7. repeated owned revoke is idempotent and does not duplicate event/outbox;
8. restart preserves list/revoke result;
9. revoke/refresh race has one serializable outcome with no resurrected target.

GREEN:

- add exact request/response guards;
- issue family + first token generation in one transaction;
- list and targeted revoke reauthenticate the caller inside the worker operation;
- targeted revoke updates family + all generations and appends the existing stable terminal event/outbox in the same transaction;
- rotation refuses a family-level revoked target and preserves public identity.

### Task 3 — Extend AuthenticationService without weakening legacy behavior

Files:

- modify `packages/server/src/auth.ts`
- modify `packages/server/src/auth.test.ts`
- modify `packages/server/src/index.ts`

RED first:

- human-only and invalid-credential behavior stays unchanged;
- two logins for the same account with two device descriptors create independent public sessions;
- JSON compatibility authority supports list/targeted revoke safely;
- public session ID is independently generated and collision-checked;
- access/refresh tokens retain existing entropy, hashing, TTL, and replay behavior;
- session summaries never include token material.

GREEN:

- add bounded device descriptor validation and independent session ID factory;
- return public current session identity with issued credentials;
- add `listSessions(accessToken)` and `revokeSession(accessToken, publicSessionId)`;
- translate closed worker errors without raw storage details.

### Task 4 — Add strict WebSocket list/revoke protocol

Files:

- modify `packages/server/src/protocol.ts`
- modify `packages/server/src/protocol.test.ts`
- modify `packages/server/src/websocket.ts`
- modify `packages/server/src/websocket.test.ts`
- modify `packages/server/src/authority.e2e.test.ts`

RED first:

- exact login device schema and length limits;
- extra/missing/empty list/revoke fields return `invalid_request`;
- same-account real sockets A/B list both sessions;
- A targeted revoke B receives correlated commit ACK;
- B receives one terminal event and closes; all B operations fail afterward;
- A remains authenticated and list converges;
- current-family logout remains terminal and no false ACK is invented;
- server restart preserves result;
- no response or error echoes password/token.

GREEN:

- parse/export new closed frame types;
- route operations through `AuthenticationService` with current access token;
- keep request ACK distinct from terminal family event;
- retain generation fencing and outbox authorization.

### Task 5 — Build Desktop auth transport and credential vault

Files:

- create `packages/desktop/src/identity/contracts.ts`
- create `packages/desktop/src/identity/contracts.test.ts`
- create `packages/desktop/src/identity/websocket-client.ts`
- create `packages/desktop/src/identity/websocket-client.test.ts`
- create `packages/desktop/src/identity/credential-vault.ts`
- create `packages/desktop/src/identity/credential-vault.test.ts`
- create `packages/desktop/src/identity/device-identity.ts`
- create `packages/desktop/src/identity/device-identity.test.ts`

RED first:

- strict parsing rejects malformed/extra/oversized server frames;
- request IDs correlate out-of-order responses and time out finitely;
- terminal revoke preempts pending work and cannot be mistaken for a transient close;
- vault ciphertext contains no credential canary and reloads after restart;
- unavailable encryption, corrupt ciphertext, failed atomic replace, and permissions fail closed;
- clear is idempotent and removes recoverable credential material;
- endpoint validator accepts loopback `ws://` and any `wss://`, rejects non-loopback cleartext and non-WebSocket schemes;
- installation device ID persists separately from credentials.

GREEN:

- implement an injectable WebSocket factory and closed auth frame parser;
- implement finite pending-request map/cleanup and terminal event callback;
- implement safeStorage adapter + atomic file replacement; require a real Linux keyring backend, enforce POSIX mode on Unix, and rely on safeStorage/userData ACL plus file-type checks on Windows;
- implement non-secret device identity store.

### Task 6 — Implement main controller and IPC/preload boundary

Files:

- create `packages/desktop/src/identity/controller.ts`
- create `packages/desktop/src/identity/controller.test.ts`
- create `packages/desktop/src/identity/ipc.ts`
- create `packages/desktop/src/identity/ipc.test.ts`
- modify `packages/desktop/src/preload.ts`
- create `packages/desktop/src/preload.test.ts`
- modify `packages/desktop/src/main.ts`
- modify `packages/desktop/src/window.ts`
- modify `packages/desktop/src/window.test.ts`

RED first:

- no credentials → signed-out;
- valid access → restored authenticated;
- expired access → one refresh → atomic save → authenticated;
- revoked/expired refresh → clear vault → revoked/signed-out;
- network error → unavailable with encrypted credentials retained;
- bad vault/encryption unavailable → fatal, no transport attempt;
- login saves before publishing authenticated; save failure revokes best-effort and fails closed;
- remote terminal revoke closes transport, invalidates authorized state, clears vault, then emits public revoked state;
- handlers reject untrusted sender/subframe and non-closed payloads;
- preload exposes only fixed frozen methods and strips Electron event objects;
- unsubscribe and IPC teardown are idempotent;
- window enables sandbox and denies navigation/new windows/permissions by default.

GREEN:

- implement a serialized IdentitySessionController state machine;
- inject a cache invalidation port now; default no-op is explicit because Room cache is not implemented;
- register allowlisted validated IPC handlers before renderer load;
- wire safeStorage, userData paths, the loopback `127.0.0.1:8787` composition default, lifecycle cleanup/macOS window recreation, and state broadcast in main;
- treat an idle transport close as `unavailable`, while strictly consuming the known principal room-access invalidation event and failing closed on unknown/malformed frames;
- expose only `window.dao.identity` from preload.

### Task 7 — Implement live renderer login/session management

Files:

- create `packages/desktop/src/renderer/identity.ts`
- create `packages/desktop/src/renderer/identity.test.ts`
- modify `packages/desktop/src/renderer/main.ts`
- modify `packages/desktop/src/renderer/styles.css`
- modify `packages/desktop/src/renderer/index.html`

RED first:

- startup skeleton precedes any authorized surface;
- signed-out renders a Human-only account/password form;
- submitting disables duplicate action, reports progress via `aria-live`, and preserves account input on failure;
- 401/403/404/409/429/503 map to closed actionable messages without secret values;
- authenticated view marks current vs other sessions, exposes remote revoke and logout, and waits for ACK/state convergence;
- terminal revoke removes authenticated/session content before rendering the revoked surface;
- keyboard focus moves to the first actionable control/error summary;
- review query routes continue to render their existing fixtures.

GREEN:

- drive all UI from `IdentityPublicState` and the preload API;
- use `textContent`, native form controls, explicit labels, and non-colour current/revoked indicators;
- add a restrictive CSP compatible with local static assets and no renderer network transport.

### Task 8 — Cross-layer evidence and delivery closeout

Files:

- create/update tests named in the acceptance matrix;
- create `docs/deliveries/FT-01-Identity-Session-交付说明.md`;
- update the acceptance matrix final-status/evidence columns only after tests pass.

Verification order:

1. focused RED/GREEN tests per task;
2. server auth/protocol/schema/persistence/WebSocket focused suite;
3. Desktop contracts/vault/transport/controller/IPC/preload/renderer suite;
4. same-account two-client real authoritative-server integration, including restart and remote revoke;
5. TypeScript build/type tests;
6. ESLint;
7. core boundary;
8. complete Vitest suite;
9. production build;
10. secret-canary scan of public DTOs, DOM, persisted Desktop files, test logs, and delivery artifacts.

The delivery note records exact commands, test counts, durations, skipped tests, environment limitations, changed migrations/contracts, and every non-closed shared dependency. A static prototype or typecheck alone is not acceptance evidence.

## 6. Failure and recovery semantics

| Failure | Server result | Desktop result | Retry rule |
| --- | --- | --- | --- |
| bad account/password | 401 `invalid_credentials` | signed-out form, account retained, password cleared | Human explicit retry |
| Agent identity mapping | 403 `identity_forbidden` | non-retryable login error | fix deployment identity |
| access expired during restore | 401 `token_expired` | one refresh attempt | automatic once |
| refresh expired/invalid | 401 | vault cleared, signed-out | full login |
| family revoked | 403 or terminal event | credentials cleared, `revoked` | full login creates new family |
| targeted foreign/unknown public ID | non-leaking 404 `session_not_found` | keep caller authenticated, refresh list | no blind automatic retry |
| targeted revoke already committed | idempotent ACK | converge list | safe retry with same request intent |
| socket/server unavailable | finite failure/close | `unavailable`, no authorized content | Human explicit retry |
| safeStorage unavailable, Linux `basic_text`, or unknown backend | no login/restore | `fatal` | fix OS encryption/keyring availability |
| vault corrupt | no transport with guessed credentials | `fatal`, credential file quarantined/cleared safely | full login after explicit recovery |
| IPC validation/sender failure | reject locally | no state change | programming/security error |
| renderer reload | no token exposure | `getState()` recovers public state | automatic public-state reload |

## 7. Definition of done

This increment is done only when all of the following are true:

- acceptance rows marked `Required` are `PASS` with linked automated evidence;
- same Human / two device descriptors / two live clients / targeted revoke is covered against the real worker-owned SQLite server;
- target credentials fail for access, refresh, protected commands, and reconnect after revoke;
- sibling device remains usable;
- Desktop credential file is encrypted and secret canaries do not appear in renderer state, DOM, logs, errors, or delivery docs;
- preload/IPC allowlist and BrowserWindow security settings are test-proven;
- startup and terminal states are finite and accessible;
- migration, legacy import, restart, and outbox delivery are tested;
- typecheck, lint, core boundary, full tests, and build pass, or any environmental skip is explicitly documented and does not hide a failed product assertion;
- delivery note states the FT-13/14 and remaining FT-01 boundaries without overclaiming.
