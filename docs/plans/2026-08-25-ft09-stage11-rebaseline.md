# FT-09 Stage 11 rebaseline

Date: 2026-08-25  
Delivery branch: `codex/ft09-stage11-project-loop`  
Authoritative predecessor: `origin/main@55aba117d8bcef5b89390a62e2a57a050fb571e1`  
Authority schema at predecessor: v22

## Authority and scope

This rebaseline is subordinate, in order, to the reconstructed PRD, approved protocol specifications, and the formal UI review linked from `docs/design/README.md`. Existing production code proves implementation only; it does not redefine product semantics. The direct FT-09 Requirement set is:

`REQ-AGT-005`, `REQ-AGT-006`, `REQ-MEM-005`, `REQ-PRIM-003`, `REQ-PRIM-010`, `REQ-PRIM-015`, `REQ-PRIM-016`, `REQ-PRIM-017`, `REQ-PRJ-001`, `REQ-PRJ-002`, `REQ-PRJ-003`, `REQ-PRJ-004`, `REQ-PRJ-005`, `REQ-PRJ-006`, `REQ-PRJ-007`, `REQ-PRJ-008`, `REQ-PRJ-009`, `REQ-PRJ-010`, `REQ-PRJ-011`, `REQ-PRJ-012`, `REQ-PRJ-013`, `REQ-ROOM-001`, `REQ-ROOM-003`, `REQ-UX-004`.

The production slice is Goal / Decision / Request / Obstacle / NextAction authority plus project-level Ball responsibility, human confirmation, authoritative sync/repair, lifecycle handling, and the formally reviewed Desktop project segment. It does not implement FT-10 side effects, tool approvals, or a generic workflow engine.

## What the predecessor already closes

- FT-02/FT-03: durable rooms, membership, stable message facts, ACK/replay, projection repair, archive/reopen and lifecycle invariants.
- FT-05: durable agent runtime and invocation facts; human/agent authority separation.
- FT-06: room memory authority and repair composition.
- FT-07: routing and assignment policy, including a trusted project-boundary origin.
- FT-08: durable Ball authority, business-timer suspension, and a fail-closed Project Boundary seam that records `dependency_unavailable` while FT-09 is absent.
- Schema v14 created departure-safe skeleton tables for `project_requests`, `project_next_actions`, `project_obstacles`, and `project_transfer_proposals`; the production departure responsibility port already reads them transactionally.

## Gaps in the predecessor

The v14 tables are deliberately insufficient as FT-09 authority. They do not model Goals or Decisions; their Request, Obstacle and NextAction shapes omit revisions, provenance, timestamps and confirmation/transition contracts; there is no project snapshot/event projection, command protocol, repair descriptor, or Desktop production surface. Project-boundary invocations are suppressed rather than converted into authoritative facts. Legacy `OpenItem`, `LightTask`, and `BallInCourt` are compatibility inputs and must not become the canonical Project Loop model.

## State and design mapping

| Journey / surface | FT | Visible transition | Source of truth |
| --- | --- | --- | --- |
| J-04 timeline mention | FT-09 | `@Human` creates a Request candidate and confirmation affordance | local transient until ACK; then stable event/projection |
| J-06 project segment | FT-09 | proposal → explicit human confirmation → project fact | server ACK followed by stable event/projection |
| J-07 recovery | FT-09 | offline, reconnect, gap and repair | durable snapshot/event projection |
| Project segment | FT-09 | Goals, Decisions, Requests, Obstacles, NextActions and Ball ownership | authoritative project projection |
| J-05 side-effect confirmation | FT-10 | tool/side-effect execution | out of scope; never represented as an FT-09 success |

Desktop baseline: 1440×900 reviewed canvas, minimum 840×560; at the minimum the left rail is 56 px and Project remains reachable as a timeline/project segment. Keyboard contracts are `Cmd+1/2/3`, `Cmd+K`, `Option+↑/↓`, and `Escape` with focus restoration. Status is never color-only; live changes use accessible announcements; zoom supports the reviewed 100–200% baseline (minimum acceptance 100–150%); reduced motion removes non-essential motion; Agent progress is not rendered as typing theatre.

All authoritative mutations follow: local intent → command/ACK → stable event/projection. Local cache state never grants permission, confirms persistence, or fabricates a successful fact.

## Error and degraded-state matrix

| State | Required behavior |
| --- | --- |
| loading | preserve navigation/context and identify the loading project segment |
| empty | distinguish no project facts from not-yet-loaded data |
| 401 | clear authenticated authority state and return to identity recovery |
| 403 | retain readable facts, reject mutation, explain permission failure |
| 409 | retain authoritative revision, expose conflict and explicit refresh/retry |
| 410 | treat retired/archived authority as unavailable; do not retry mutation blindly |
| 429 | bounded retry guidance; no optimistic success |
| 503 | degraded/offline state, bounded reconnect, no local authority claim |
| offline | allow inspection of labelled cached projection only; queue no silent authoritative mutation |
| repair | replace the affected projection atomically after validated repair |

## Delivery constraints

- No Blueprint content or renderer is changed, and no task is marked `verified` by the executor.
- The four pre-existing untracked plan files in `/Users/leo/code/Dao` are protected and must retain their recorded hashes.
- Design deviation: **none**.
- A visible state absent from the formal review is not invented; unsupported demo behavior remains prototype-only.

