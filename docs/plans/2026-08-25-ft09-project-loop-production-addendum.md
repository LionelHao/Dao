# FT-09 Project Loop production addendum

Date: 2026-08-25  
Predecessor: `origin/main@55aba117d8bcef5b89390a62e2a57a050fb571e1`, authority schema v22

## Canonical aggregate

A Project is room-scoped (`projectId === roomId`) and exposes five canonical fact families:

- Goal: the intended outcome and its lifecycle.
- Decision: an immutable decision record with explicit replacement/supersession rather than silent editing.
- Request: a directed request with a responsible human or agent, status, provenance and revision.
- Obstacle: a blocking fact with state and responsibility.
- NextAction: a concrete next action with responsibility, due boundary and completion state.

Ball is a derived responsibility projection over unresolved Request, Obstacle and NextAction facts. Existing `OpenItem`, `LightTask`, Blueprint facts and FT-08 Ball records may feed compatibility projections, but they do not redefine the canonical FT-09 fact contracts.

## Confirmation and transition rules

Agent output may propose facts but cannot silently commit human-owned project decisions. A proposal carries a stable ID, room/project binding, proposer, target fact kind, bounded payload and base revision. Explicit human confirmation atomically either creates the fact and closes the proposal, or returns a typed conflict. Replays are idempotent. Rejection closes the proposal without creating a fact.

Every mutation checks actor, tenant, room membership, room lifecycle, current revision and allowed transition. A successful ACK describes an accepted authoritative result; stable events and projection repair establish durable client state. Unauthorized, stale, retired, malformed and unavailable operations fail closed.

Project-boundary invocations accepted by FT-08 become a proposal or authoritative system fact only through the FT-09 authority port. When the authority is unavailable the existing durable suppression remains correct; no in-memory fallback is allowed.

## Persistence change

The schema advances beyond v22 with append-only migration semantics. The migration must preserve and validate v14 rows, add the missing Goal/Decision/proposal/project-event/projection authority, and strengthen Request/Obstacle/NextAction without destructive table replacement. Required database invariants include tenant/room binding, bounded text and identifiers, monotonic revisions, legal statuses, unique idempotency keys, immutable event identity, participant references, and departure-safe responsibility lookup.

Worker operations are closed discriminated unions with runtime validation. Writes run in one SQLite transaction and return only validated results. Snapshot/repair reads are stable-page, bounded and registry-composed. Restart and replay must produce the same projection.

## Protocol and repair change

The public protocol gains bounded Project Loop query/mutation frames and typed ACKs. It must reject excess keys, malformed IDs, oversized text, non-monotonic cursors and mismatched room/project IDs. WebSocket dispatch uses the authenticated command context; clients cannot supply trusted actor or tenant fields.

Stable sync adds Project Loop facts/events and a project repair descriptor. Descriptor identity, ordering and projection kind are unique; repair is room-scoped and lifecycle-aware. Snapshot replacement is atomic on Desktop, rejects wrong-room data and preserves the previous valid projection on malformed input.

## Desktop production change

The reviewed project segment is integrated into the production renderer and bridge, not mounted as an isolated demo. It renders Goals, Decisions, Requests, Obstacles, NextActions and Ball ownership from the authoritative replica. Proposal confirmation is explicit and keyboard operable. Loading, empty, permission, conflict, retired, rate-limited, unavailable, offline and repairing states are distinguishable in text and announced where appropriate.

The renderer does not expose Node/Electron authority directly. Preload IPC contracts are allowlisted and validated. Focus restoration, non-color indicators, zoom and reduced-motion contracts follow the formal design baseline.

## Requirement-to-implementation acceptance matrix

| Requirement group | Production seam | Required proof |
| --- | --- | --- |
| REQ-PRJ-001..005 | core Project/Goal/Decision/Request/Obstacle/NextAction contracts and state machine | closed validators; legal/illegal transition unit tests |
| REQ-PRJ-006..009 | proposal/confirmation authority and project Ball derivation | human/agent permission, idempotency, stale revision and ownership tests |
| REQ-PRJ-010..013 | durable event/projection, recovery and lifecycle integration | transaction, restart, multi-client replay, archive/reopen/departure tests |
| REQ-AGT-005/006 | agent proposal and trusted project-boundary integration | spoof rejection, unavailable suppression, accepted proposal tests |
| REQ-MEM-005 | project facts available to bounded authoritative context | snapshot/repair/context projection tests |
| REQ-PRIM-003/010/015..017 | canonical primitive shape, revisions, provenance and confirmation | protocol validator and database invariant tests |
| REQ-ROOM-001/003 | room scope, membership and lifecycle | 403/410, cross-room and archived-room tests |
| REQ-UX-004 | reviewed Desktop states and accessibility | renderer/bridge tests plus production build/smoke evidence |

Design deviation: **none**.

