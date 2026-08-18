# FT-01 Identity & Session · Acceptance Matrix

> Date: 2026-08-18
> Plan: [`2026-08-18-ft01-identity-session-implementation-plan.md`](./2026-08-18-ft01-identity-session-implementation-plan.md)
> Status legend: `PASS` means the linked evidence passed on the final working tree; `DEPENDENCY` is approved cross-FT scope and is not evidence of this slice's completion; `NOT RUN` is reserved for an environmental limitation.

## A. Identity and credential authentication

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-AUTH-01 | REQ-ID-001 | Given a Human password account, when credentials are correct, then the real auth authority issues a Human-bound session; the client cannot select actor ID/kind. | `auth.test.ts`, `websocket.test.ts`, `authority.e2e.test.ts` | PASS |
| FT01-AUTH-02 | REQ-ID-001 | Given a missing account or wrong password, when login runs, then both fail as 401 without a session/event/outbox and without revealing which field was wrong. | `auth.test.ts`, secret-canary assertions | PASS |
| FT01-AUTH-03 | REQ-ID-001 / PRIM-001 | Given an identity record mapped to an Agent or missing Human actor, when login runs, then it fails 403 and persists nothing. | `auth.test.ts`, SQLite store test | PASS |
| FT01-AUTH-04 | REQ-NFR-009 | Given password/access/refresh canaries, when login, error, persistence, UI rendering, and delivery complete, then canaries occur only in the intentional in-memory request boundary and encrypted vault plaintext before encryption—not DB/events/logs/DOM/public DTO/docs. | auth/vault/renderer tests + delivery scan | PASS |
| FT01-AUTH-05 | REQ-NFR-001/013 | Given a configured endpoint, when Desktop connects, then loopback `ws://` and `wss://` are allowed, non-loopback plaintext WebSocket and renderer-selected URLs are rejected. | server listener validation + Desktop endpoint tests | PASS |

## B. Device session families

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-SESS-01 | REQ-ID-002 | Given the same account logs in as MacBook and iMac, when both ACKs commit, then two different server-issued public session IDs exist and both families authenticate concurrently. | auth + SQLite + real WS two-client tests | PASS |
| FT01-SESS-02 | REQ-ID-002 | Given an authenticated device, when it lists sessions, then only its account/actor families are returned, exactly one is current, order is deterministic, and no token/hash/internal family ID appears. | authority/store/protocol tests | PASS |
| FT01-SESS-03 | REQ-ID-002 | Given a family refreshes, when tokens rotate, then its public session ID/device metadata stay stable, old generation fails, new generation works, and refresh horizon updates. | auth/store/WS tests | PASS |
| FT01-SESS-04 | REQ-ID-002 | Given A, B, and C belong to the same Human, when A revokes B, then B access/refresh/resume fail while A and C remain authenticated and refreshable. | authority multi-controller E2E + SQLite access/refresh + WebSocket resume tests | PASS |
| FT01-SESS-05 | REQ-ID-002 / NFR-003 | Given B has multiple live connections in one family, when A revokes B, then each receives the stable terminal event and closes; one durable revoke event/outbox exists. | WebSocket/outbox integration tests | PASS |
| FT01-SESS-06 | REQ-ID-002 | Given A revokes B, when the authority transaction commits, then A receives a request-correlated revoke ACK and remains logged in; terminal target delivery is a separate frame. | protocol/WebSocket tests | PASS |
| FT01-SESS-07 | REQ-NFR-011 | Given another account's public session ID or a random ID, when targeted revoke runs, then the result does not disclose ownership and no target/sibling state changes. | worker transaction + WS tests | PASS |
| FT01-SESS-08 | REQ-NFR-002/003 | Given an owned target was already revoked and ACK was lost, when the same intent is retried, then the result is idempotent and no duplicate event/outbox is created. | persistence fault/idempotency test | PASS |
| FT01-SESS-09 | REQ-NFR-011 | Given refresh and revoke race for B, when transactions interleave, then either refresh linearizes first and is subsequently revoked, or revoke wins and refresh fails; no valid B token survives committed revoke. | deterministic AuthorityWorker race test | PASS |
| FT01-SESS-10 | REQ-ID-002 / NFR-004 | Given server restart, when sessions are listed/refreshed/revoked afterward, then public IDs, device metadata, expiry, and revoke state are preserved. | SQLite/restart/authority E2E | PASS |
| FT01-SESS-11 | existing auth contract | Given exact access/refresh expiry, replayed refresh, malformed token, or current logout, then existing 401/403 and whole-family semantics remain unchanged. | existing + extended auth/WebSocket tests | PASS |
| FT01-SESS-12 | bounded wire/resource contract | Given 96 active, unexpired device families for one account/Human, when another valid password login is attempted, then the deterministic oldest family is revoked and the replacement is issued in the same transaction, keeping 96 and producing the normal terminal event/outbox; an anomalous legacy state above 96 fails migration/import/list explicitly rather than truncating, and valid list responses stay inside the Desktop 64 KiB/96-session parser contract. | auth + schema/import + AuthorityWorker/store + Desktop transport/controller tests | PASS |

## C. Persistence, migration, and authority

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-DATA-01 | REQ-NFR-002 | Given a fresh DB, when migration completes, then schema v12 and exact `session_families` contract/fingerprint/invariants are present. | `schema.test.ts` | PASS |
| FT01-DATA-02 | REQ-NFR-004 | Given a valid v11 DB with rotated/active/revoked token generations, when v12 applies, then one correct family projection per family is backfilled without changing credential validity. | `schema.test.ts`, persistence test | PASS |
| FT01-DATA-03 | REQ-NFR-005 | Given injected failure during v12, when migration aborts, then DB schema/data/version/migration history remain exactly v11. | migration fault test | PASS |
| FT01-DATA-04 | migration compatibility | Given a legacy JSON session import, when authority imports it, then token validity is preserved and explainable legacy device metadata is produced. | `legacy-importer.test.ts` | PASS |
| FT01-DATA-05 | REQ-NFR-002/003 | Given targeted revoke, when commit succeeds, then family state, all token generations, stable identity event, and target-family outbox are atomically visible. | SQLite transaction fault tests | PASS |
| FT01-DATA-06 | REQ-NFR-011 | Given list/revoke input from an already revoked/expired caller, when worker executes, then it fails inside the authoritative operation before returning or mutating a projection. | worker/store tests | PASS |

## D. Closed wire protocol

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-WIRE-01 | REQ-NFR-010 | Given login device metadata, list, or targeted revoke with missing/empty/extra/oversized/wrong-type fields, when parsed, then `invalid_request` is returned and auth service is not called. | `protocol.test.ts` | PASS |
| FT01-WIRE-02 | REQ-UX-007 | Given concurrent requests and out-of-order responses, when responses arrive, then only the matching `requestId` completes each operation. | server WS + Desktop transport tests | PASS |
| FT01-WIRE-03 | REQ-NFR-005/010 | Given no server response or a closed socket, when timeout/close occurs, then all pending requests reach a finite sanitized failure and listeners are released. | Desktop WebSocket client tests | PASS |
| FT01-WIRE-04 | REQ-NFR-009 | Given malformed frames/errors, when Desktop parses them, then it rejects unknown fields and never includes raw payload/credential values in public error text. | Desktop frame parser/canary tests | PASS |
| FT01-WIRE-05 | REQ-NFR-003 | Given target terminal outbox delivery, when frame is sent before socket close, then Desktop observes revocation even if the correlated revoke was initiated on another device. | real WS/Desktop-controller integration | PASS |

## E. Desktop credential lifecycle and controller

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-DESK-01 | REQ-UX-006 | Given no stored credential, when Desktop starts, then it closes `starting` as `signed-out` and never renders authorized Room/session content. | controller + renderer tests | PASS |
| FT01-DESK-02 | REQ-UX-006 | Given a valid encrypted access credential, when Desktop starts, then it resumes through the real transport and publishes authenticated state only after server acceptance. | controller integration test | PASS |
| FT01-DESK-03 | REQ-UX-006 | Given expired access and valid refresh, when restore runs, then exactly one refresh rotates credentials, the new pair is atomically encrypted, and only then is authenticated state published. | controller/vault/real WS test | PASS |
| FT01-DESK-04 | REQ-ID-005 / NFR-008 | Given current family terminal revocation, when Desktop receives it, then transport/authorized in-memory state are invalidated, credential storage is cleared, cache invalidation port is called, and public state becomes revoked in that order. | controller order assertions | PASS |
| FT01-DESK-05 | REQ-NFR-008 | Given Human logout, when revoke commits/terminal arrives, then recoverable credentials are cleared and a subsequent start cannot resume them. | controller + restart test | PASS |
| FT01-DESK-06 | REQ-NFR-007/008 | Given network unavailable but vault is valid, when restore fails, then state is unavailable, encrypted credentials are retained for explicit retry, and no authorized content is shown. | controller tests | PASS |
| FT01-DESK-07 | REQ-NFR-008/013 | Given safeStorage unavailable or ciphertext corrupt, when start/login runs, then it fails closed as fatal with no plaintext fallback or guessed transport request. | vault/controller tests | PASS |
| FT01-DESK-08 | REQ-NFR-008/009 | Given credential canaries, when vault saves, then disk contains ciphertext only, atomic replacement is used, and file/directory permissions are restricted. | credential-vault tests | PASS |
| FT01-DESK-09 | REQ-ID-002 | Given credential clear/logout, when the user logs in again on the same installation, then non-secret device ID remains stable while old session credentials do not. | device/vault/controller test | PASS |

## F. Preload, IPC, and Electron security

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-IPC-01 | REQ-NFR-013 | Given renderer code, when inspecting `window.dao.identity`, then only the six named methods exist; there is no raw `ipcRenderer`, channel selector, token, fs, shell, endpoint, or Electron event. | preload contract test | PASS |
| FT01-IPC-02 | REQ-NFR-013 | Given preload method calls, when invoked, then each uses one fixed channel and closed input; returned state is sanitized/frozen. | preload/contract tests | PASS |
| FT01-IPC-03 | REQ-NFR-013 | Given a subframe, unknown window, extra field, wrong type, or oversized IPC payload, when a handler receives it, then it rejects before controller invocation. | IPC tests | PASS |
| FT01-IPC-04 | REQ-NFR-005 | Given state subscriptions and teardown/reload, when unsubscribe/close repeats, then listeners and handlers are removed idempotently with no duplicate broadcast. | preload/IPC/main tests | PASS |
| FT01-IPC-05 | REQ-NFR-013 | Given the BrowserWindow, when created, then context isolation, sandbox, web security are on; Node integration is off; preload path is fixed. | `window.test.ts` | PASS |
| FT01-IPC-06 | REQ-NFR-013 | Given attempted navigation, new window, or permission request, when Electron main observes it, then it denies by default. | main/window policy unit tests + Electron smoke | PASS |
| FT01-IPC-07 | REQ-NFR-013 | Given built preload/renderer output, when inspected, then renderer has no Node/Electron import and CSP denies renderer network/eval/object embedding. | build/boundary/CSP tests | PASS |

## G. Renderer behavior and accessibility

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-UI-01 | REQ-UX-006 | Given startup, when public state is unresolved, then an auth skeleton/status is shown before any login/session/Room content. | JSDOM renderer test | PASS |
| FT01-UI-02 | REQ-ID-002 / PRIM-001 | Given signed-out state, when UI renders, then only a Human account/password login is offered; there is no Agent login path. | JSDOM renderer test | PASS |
| FT01-UI-03 | REQ-UX-007 | Given login submit, when pending/success/error occurs, then duplicate submit is disabled, success waits for controller state, account input is retained, password is cleared, and finite error/retry action is shown. | renderer interaction tests | PASS |
| FT01-UI-04 | REQ-ID-002 | Given authenticated sessions, when list renders, then current and other devices are distinguishable by text, expiry is visible, and remote revoke/current logout actions are separate. | renderer tests | PASS |
| FT01-UI-05 | REQ-UX-007 | Given remote revoke, when button is used, then pending state remains until matching ACK/state; an error does not remove the target optimistically. | renderer/controller test | PASS |
| FT01-UI-06 | REQ-ID-005 / UX-006 | Given terminal revoke, when state changes, then authenticated/session content is removed before the revoked explanation and login action render. | renderer ordering test | PASS |
| FT01-UI-07 | REQ-UX-006/009 | Given keyboard/assistive use, when states/errors change, then controls have labels, focus moves predictably, status uses `aria-live`, and current/revoked meaning is not colour-only. | JSDOM accessibility assertions | PASS |
| FT01-UI-08 | regression | Given existing `m2-primitives`, `join-review`, or `visual-review` routes, when rendered, then static review evidence remains unchanged. | existing `app.test.ts` + entry test | PASS |

## H. Cross-layer and quality gates

| ID | Requirement | Given / When / Then | Automated evidence target | Status |
| --- | --- | --- | --- | --- |
| FT01-E2E-01 | REQ-ID-002 | Given a real worker SQLite server and three independent Desktop auth-controller profiles for one Human, when all login, A lists, and A revokes B, then B clears/locks while A and C stay usable. | cross-layer multi-controller integration test | PASS |
| FT01-E2E-02 | REQ-NFR-004/005 | Given A/B/C have logged in, B has been revoked, and the server restarts, when A restores with expired access, refreshes, lists, logs out, restarts its controller, and logs in again on the same installation, then every state is finite and no old credential resumes. | cross-layer restart/refresh/logout/relogin test | PASS |
| FT01-E2E-03 | REQ-NFR-009 | Given E2E canaries, when artifacts are scanned, then public states, DOM, DB, logs, and docs contain no raw password/access/refresh values. | automated canary test + delivery command | PASS |
| FT01-GATE-01 | engineering gate | TypeScript project build and type tests pass. | `corepack pnpm typecheck` | PASS |
| FT01-GATE-02 | engineering gate | ESLint passes with zero warnings. | `corepack pnpm lint` | PASS |
| FT01-GATE-03 | engineering gate | Core zero-I/O and Desktop renderer-authority boundaries pass. | `corepack pnpm verify:core-boundary`; `corepack pnpm verify:desktop-boundary` | PASS |
| FT01-GATE-04 | engineering gate | Entire automated test suite passes. | `corepack pnpm test` | PASS |
| FT01-GATE-05 | engineering gate | All workspace production builds pass, Desktop output contains the preload/renderer assets, and the built sandbox bridge completes an IPC round trip. | `corepack pnpm build`; `corepack pnpm --filter @native-im/desktop smoke` | PASS |
| FT01-GATE-06 | delivery gate | Delivery note records exact commands/counts, migration/protocol changes, known limits, and no overclaim. | `docs/deliveries/FT-01-Identity-Session-交付说明.md` | PASS |

## I. Approved dependencies — not evidence of this increment's completion

| ID | Requirement | Remaining owner/boundary | Status |
| --- | --- | --- | --- |
| FT01-DEP-01 | REQ-ID-003 | Invitation-bound account creation, disclosure, explicit Human acceptance: FT-01 follow-up shared with FT-02/16. | DEPENDENCY |
| FT01-DEP-02 | REQ-ID-004 / AGT-004 / NFR-006 | Tenant Administrator bootstrap/audit, Global Agent Profile, provider credential governance: shared FT-01/07/14. | DEPENDENCY |
| FT01-DEP-03 | REQ-ID-005 / NFR-008 | Encrypted Room cache, online per-Room purge, finite service-signed offline read lease and threat-model limits: FT-13/14. | DEPENDENCY |
| FT01-DEP-04 | REQ-ROOM-004 / NFR-014 | Archive/reopen security-governance concurrency: FT-02/10/13; session revoke must remain callable. | DEPENDENCY |
| FT01-DEP-05 | production operations | Production server launcher, account provisioning CLI/API, TLS termination, packaging/notarization and macOS multi-process smoke CI. | DEPENDENCY |

## Final acceptance rule

All required rows in A–H passed on the final working tree. The two environment-gated OpenAI live smoke tests are outside FT-01 and remain skipped unless `DAO_OPENAI_LIVE_SMOKE=1` and `OPENAI_API_KEY` are supplied; no FT-01 row relies on them. A `DEPENDENCY` row is intentionally never promoted to `PASS` by this slice.
