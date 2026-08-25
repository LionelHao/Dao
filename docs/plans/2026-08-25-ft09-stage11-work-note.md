# FT-09 Stage 11 work note

Date: 2026-08-25  
Integration worktree: `/Users/leo/code/Dao-ft09-stage11`  
Integration branch: `codex/ft09-stage11-project-loop`

## TDD order

1. Core red: closed fact/proposal/command/event validators; transition and Ball derivation failures.
2. Persistence red: v22→new schema migration, v14 preservation, transactional idempotency/conflict, restart and corrupt-row handling.
3. Protocol red: exact frames/ACKs, authenticated dispatch, replay, cross-room and payload-bound rejection.
4. Sync/repair red: stable events, descriptor registration, bounded stable pages, wrong-room/malformed repair rejection.
5. Boundary/lifecycle red: FT-08 suppression replacement, archive/reopen, departure transfer and business-timer behavior.
6. Desktop red: authoritative replica, bridge validation, J-04/J-06/J-07 states, errors, keyboard/focus/accessibility and responsive layout.
7. Integrated red/green: real server plus two clients, disconnect/gap/repair/restart, permissions, stale conflict and production smoke.

No production implementation begins before this rebaseline commit. Tests must fail for the intended missing behavior before the matching production change is accepted.

## Parallel ownership

| Owner | Exclusive implementation area | Primary outputs |
| --- | --- | --- |
| Core agent | `packages/core/src/project-loop*`, core exports/tests | canonical contracts, validators, state machine, Ball derivation |
| Authority agent | schema/migration and `packages/server/src/project-loop` authority/worker operations | durable transaction authority, v14 upgrade, restart/idempotency proofs |
| Protocol/Desktop agent | public frames, sync/repair contracts, Desktop bridge/replica/surface | authenticated protocol, repair projection, reviewed production UI |
| Lead/integrator | rebaseline, composition, FT-08 boundary, lifecycle/departure, integration and adversarial review | clean merge, cross-layer gates, delivery evidence |

Agents start from the same production predecessor and may not edit Blueprint artifacts. Cross-owner contract changes are coordinated through the lead. Each branch must provide red/green evidence and a focused commit.

## Merge order

1. Rebaseline documentation commit.
2. Core contracts/state machine.
3. Persistence authority and schema migration.
4. Protocol/sync/Desktop.
5. Lead composition, lifecycle and integration fixes.
6. Independent adversarial review fixes.
7. Implementation PR, required CI, remote `main` merge.
8. Evidence-only PR containing final Requirement/code/test/UI trace and immutable merge/CI references, required CI, remote `main` merge.
9. Fetch/prune, verify real remote state, protect original untracked hashes, remove all temporary worktrees and prune registrations.

## File impact map

| Layer | Expected files / directories | Contract |
| --- | --- | --- |
| Core | `packages/core/src/collaboration.ts`, `project-loop*`, `sync.ts`, exports | five facts, proposals, revisions, events, repair records |
| Schema | `packages/server/src/persistence/schema.ts` and migration tests | append-only post-v22 migration preserving v14 rows |
| Authority | `packages/server/src/project-loop/*`, worker protocol/client/handler | atomic command/query authority and validated results |
| Protocol | `packages/server/src/protocol.ts`, `websocket.ts`, service composition | exact commands/ACKs and authenticated dispatch |
| Sync/repair | sync service, authority event mapping, repair registry/composition | stable project events and bounded project projection repair |
| Lifecycle | room governance, departure port, business timers, project boundary | archive/reopen/departure and FT-08→FT-09 production handoff |
| Desktop | main/preload IPC, sync replica, renderer project-loop surface and CSS | J-04/J-06/J-07, all reviewed states and accessibility |
| Evidence | tests, delivery note and approved implementation map only where truth changes | Requirement → code → test → UI traceability |

## Requirement-to-code/test/UI trace plan

| Requirements | Code owner | Test class | UI/design state |
| --- | --- | --- | --- |
| REQ-PRJ-001..005, REQ-PRIM-003/010 | Core | validators/state transition | J-06 fact lists/detail |
| REQ-PRJ-006..009, REQ-PRIM-015..017 | Core + Authority | proposal confirmation, conflict, Ball | J-04 proposal; J-06 confirmation/Ball |
| REQ-PRJ-010..013, REQ-MEM-005 | Authority + Protocol | restart, replay, repair, snapshot | J-07 offline/repair |
| REQ-AGT-005/006 | Lead + Authority | trusted-origin/spoof/unavailable | J-04 Agent proposal without typing theatre |
| REQ-ROOM-001/003 | Lead | membership/archive/reopen/departure | 403/410 and read-only archived states |
| REQ-UX-004 | Protocol/Desktop | keyboard, focus, announcements, resize/zoom/reduced motion | formal Project segment at 1440×900 and 840×560 |

## Mandatory gates

- focused unit suites for every touched package;
- repository typecheck, lint and full test suite;
- schema fingerprint/migration and production composition tests;
- server authority E2E with two clients, reconnect/repair and restart;
- Desktop production build and Electron smoke;
- adversarial validation of actor spoofing, cross-room access, stale revisions, replay, oversized/malformed data, corrupt persistence, descriptor duplication, offline mutation and lifecycle races.

Design deviation: **none**. Blueprint edit/verification authority: **none**.

