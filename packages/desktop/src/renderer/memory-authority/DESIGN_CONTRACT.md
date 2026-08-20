# FT-05 Memory Authority Desktop contract

- Requirement: `REQ-MEM-001/002/005/006/007/010`, `REQ-MSG-005/006/010`, `REQ-PRIM-008/014`, `REQ-UX-004/007/009`.
- Formal journeys: `J-04 @Human Request` (an ACK is not responsibility acceptance), `J-06 proposal → Human confirmation → project fact`, `J-07 notification/offline → fixed-watermark repair`.
- Component: the current Room right rail, “重要记忆 · 5 类”; never a cross-Room search route.
- Authority sources: filters/dialog input are local transient; submit success is a matching ACK; memory/version/watermark/health are stable event/projection/repair; offline is connection state plus the last complete authorized cache; revoke is server reauthorization/event plus purge.
- Reachable states: loading, empty, healthy, catching-up, active/disputed/resolving/resolved/superseded/review-required, proposal, unavailable project reference, active/revised/recalled/unavailable source, noauth/degraded/recovery-required, offline/repairing/repair-failed, archived read-only, revoked, and 400/401/403/404/409/410/429/503.
- Actions: current Human may dispute Context; only the original disputing Human, or owner/admin after a recorded steward reevaluation, may resolve; the server remains the final authority. Retry creates a new recovery attempt. Source navigation never restores recalled raw content.
- Accessibility: keyboard-reachable cards/sources/actions; dialog focus trap and Escape return; text/icon/structure rather than colour; bounded low-frequency polite announcements; preview/progress remain live-off; VoiceOver labels; 1440×900, 840×560, 200% zoom, reduced motion.
- Security: renderer never receives provider prompt/body/header/reasoning/secret, raw recalled body, attachment extraction, object path/key/token, generic URL or generic command.
- Design supplementation: the Stage 7 owner instruction supplies the detailed Memory health/source/error states absent from the formal review's static panel. Existing information architecture and visual semantics are unchanged. Deviation: none. Evidence: this contract, reachable DOM tests, bridge/controller tests, and production Electron smoke.
