# T-0039 Identity and Room Lifecycle Implementation Plan

**Goal:** Build server-authoritative human authentication, durable sessions, governed room membership, human invitations, agent configuration, and authenticated message access without collapsing human and agent join semantics.

**Architecture:** Keep `@native-im/core` zero-I/O and add only discriminated collaboration contracts there. Put credentials, session persistence, room lifecycle state, authorization, and audit behind three server modules: `AuthenticationService`, `RoomLifecycleService`, and the existing `MessageService`; the WebSocket adapter composes them and never accepts a client-selected author identity. Persist T-0039 identity/session/room state as atomically replaced JSON documents through injected stores; T-0040 will later unify all event durability, cursors, migrations, and outbox behavior.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-ins (`crypto`, `fs/promises`), `ws`, Electron, Vitest, JSDOM, pnpm workspace.

---

## Work note: acceptance criteria copied before implementation

1. 服务端通过认证适配器验证真人身份并签发可刷新、可撤销的会话；客户端不能自行指定或替换 actor ID。两个独立客户端以两个不同账户登录同一服务实例，服务与客户端重启后会话按既定过期规则恢复；篡改 actor ID、复用已撤销会话分别返回 401 / 403，并有自动化测试。
2. 真人可创建群；邀请链接或邀请码可被另一真人接受或拒绝，服务端记录邀请人与结果。
3. 群主或管理员才可重命名、归档、邀请、移出成员和配置 agent；普通成员直接调用对应 API 均返回 403。权限在服务端执行，不以隐藏界面按钮代替。
4. 加入真人走邀请流程；加入 agent 走配置流程，必须同时选择参与度和工具权限，两个流程在 API 类型和界面入口上均不同。
5. 未加入群的身份不能查询历史、订阅实时消息或发消息；至少有一条自动化测试分别断言三个越权入口被拒绝。
6. 删除或移出成员不会删除其历史发言；后续寻址与新消息权限立即失效，审计事件可查询。

## Inputs and boundaries

- PRD 2.3 #6 is the primary primitive: a human joins through an invitation that can be accepted or rejected; an agent joins through immediate capability configuration containing participation and tool permissions. Their data types, service methods, renderer entry points, and typed submit callbacks must remain different. Public room-management transport frames are deferred with the full onboarding/network integration boundary.
- PRD 2.3 #13 applies to membership data: human membership carries a social role and join time; agent membership carries participation and granted tool permissions.
- Acceptance General §2 requires data, interface, and renderer separation. T-0039's own criterion requires client-selected actor identity to return 401 and revoked sessions to return 403; authenticated room permission failures also return 403.
- The current message WebSocket trusts `Message.authorId`; T-0039 removes that trust. Clients send a `MessageDraft` without author fields, and the server derives `authorId` / `authorKind` from the authenticated session.
- Sessions and room lifecycle survive process restart here because the task explicitly requires it. Message/event-wide authority, schema migration, replay cursors, and outbox failure injection remain T-0040.
- The desktop UI only provides working invite/configuration entry modules and typed submit callbacks. Full onboarding, remote deployment, and production login screens remain T-0042 / T-0043.

## Domain vocabulary

- **Account:** credential record verified by an identity adapter. It maps to exactly one human actor for T-0039.
- **Session:** server-issued access/refresh token pair binding a verified account to its human actor. The client never supplies an actor ID when acting.
- **Human invitation:** targeted request created by an owner/admin and decided by the invited human. Rejection is a recorded terminal result, not an error.
- **Agent configuration:** owner/admin command that immediately creates or replaces an agent membership with participation and a granted subset of tool permissions. It has no acceptance step.
- **Human membership:** room relation with role `owner | admin | member` and `joinedAt`.
- **Agent membership:** room relation with `participation`, granted `toolPermissions`, and `configuredAt`.
- **Removal:** revokes future room access and addressing while preserving authored messages and audit history.

## Buzz reference, translation, and deviation

- **Reference:** Buzz keeps identity/authentication, membership, authorization filtering, persistent ingest, and WebSocket transport in separate modules; its relay composition root wires them together. Membership and authorization are checked before room/channel history or event delivery.
- **Translation:** TypeScript interfaces become seams for `IdentityAdapter`, session state, and room lifecycle state. `websocket.ts` is the composition adapter; it derives the principal from `AuthenticationService`, asks `RoomLifecycleService` for current membership, then calls `MessageService`.
- **Deviation:** Do not adopt Nostr public keys, community/multi-tenant isolation, Redis, media, or workflow engines. T-0039 uses local accounts plus opaque rotating tokens and single-product rooms. Buzz treats agents largely as shared participants; this product deliberately uses separate human invitation and agent configuration contracts.

## File structure

- Create `CONTEXT.md` — implementation-free glossary for account, session, invitation, agent configuration, memberships, and removal.
- Modify `packages/core/src/index.ts` and tests — add `MessageDraft`, human/agent membership unions, join request unions, room status, and strict guards while preserving zero I/O.
- Create `packages/server/src/state-store.ts` and tests — injected in-memory store interface plus atomic queued JSON-file adapter used by auth and room state.
- Create `packages/server/src/auth.ts` and tests — scrypt identity adapter, opaque hashed tokens, refresh rotation, revoke, expiry, restart recovery.
- Create `packages/server/src/room-lifecycle.ts` and tests — room create/rename/archive, invite accept/reject, agent configuration, role checks, removal, current membership directory, audit.
- Modify `packages/server/src/{service,protocol,websocket,index}.ts` and tests — authenticated authorship, separate history/subscribe/send authorization, 401/403 frames, login/resume/refresh/revoke transport.
- Modify `packages/desktop/src/renderer/app.ts`, `app.test.ts`, `styles.css`, and `main.ts` — distinct, functional human invitation and agent configuration entries.
- Create `docs/protocols/identity-room-lifecycle.md` and `docs/deliveries/T-0039-真实身份群与加入生命周期-交付说明.md` — normative contract and four-section handoff.

### Task 1: Lock the domain language and pure collaboration contracts

**Files:**

- Create: `CONTEXT.md`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`
- Create: `packages/core/src/collaboration.type-test.ts`

- [x] **Step 1: Write failing runtime and type-level tests for different human and agent join contracts.**

```ts
const humanJoin = {
  kind: "human-invitation",
  roomId: "room-1",
  inviteeActorId: "human-2",
} as const;
const agentJoin = {
  kind: "agent-configuration",
  roomId: "room-1",
  agentId: "agent-search",
  participation: "active",
  toolPermissions: ["search"],
} as const;

expect(domain.isHumanInvitationRequest?.(humanJoin)).toBe(true);
expect(domain.isAgentConfigurationRequest?.(agentJoin)).toBe(true);
expect(domain.isHumanInvitationRequest?.(agentJoin)).toBe(false);
expect(domain.isAgentConfigurationRequest?.(humanJoin)).toBe(false);
expect(domain.isMessageDraft?.({
  id: "message-1",
  roomId: "room-1",
  body: "由会话决定作者",
  sentAt: "2026-08-09T00:00:00.000Z",
})).toBe(true);
expect(domain.isMessageDraft?.({
  id: "message-forged",
  roomId: "room-1",
  authorId: "human-2",
  body: "冒充",
  sentAt: "2026-08-09T00:00:00.000Z",
})).toBe(false);
```

`collaboration.type-test.ts` must include compile-time failures proving a human membership cannot carry `participation` and an agent membership cannot carry `role`.

- [x] **Step 2: Run RED and confirm failure is missing types/guards.**

Run: `pnpm typecheck && pnpm exec vitest run packages/core/src/index.test.ts`

Expected: typecheck or test fails because the new collaboration exports do not exist; existing actor/message tests still compile.

- [x] **Step 3: Add the smallest pure contracts and guards to core.**

```ts
export type HumanRoomRole = "owner" | "admin" | "member";
export type AgentParticipation = "active" | "on-mention" | "silent";
export type RoomStatus = "active" | "archived";

export interface HumanRoomMembership {
  readonly kind: "human";
  readonly actorId: string;
  readonly role: HumanRoomRole;
  readonly joinedAt: string;
  readonly participation?: never;
  readonly toolPermissions?: never;
}

export interface AgentRoomMembership {
  readonly kind: "agent";
  readonly actorId: string;
  readonly participation: AgentParticipation;
  readonly toolPermissions: readonly string[];
  readonly configuredAt: string;
  readonly role?: never;
  readonly joinedAt?: never;
}

export interface HumanInvitationRequest {
  readonly kind: "human-invitation";
  readonly roomId: string;
  readonly inviteeActorId: string;
  readonly participation?: never;
  readonly toolPermissions?: never;
}

export interface AgentConfigurationRequest {
  readonly kind: "agent-configuration";
  readonly roomId: string;
  readonly agentId: string;
  readonly participation: AgentParticipation;
  readonly toolPermissions: readonly string[];
  readonly inviteeActorId?: never;
}

export interface MessageDraft {
  readonly id: string;
  readonly roomId: string;
  readonly body: string;
  readonly sentAt: string;
  readonly authorId?: never;
  readonly authorKind?: never;
}

export interface ManagedRoom {
  readonly id: string;
  readonly name: string;
  readonly status: RoomStatus;
  readonly members: readonly (HumanRoomMembership | AgentRoomMembership)[];
  readonly createdAt: string;
}
```

The `MessageDraft` guard must explicitly reject `authorId` and `authorKind`; guards for the two join requests and two memberships must require their own fields and reject fields belonging to the other kind.

- [x] **Step 4: Write `CONTEXT.md` with the exact vocabulary above, then verify GREEN.**

Run: `pnpm typecheck && pnpm exec vitest run packages/core/src/index.test.ts && pnpm verify:core-boundary`

Expected: core tests and type tests pass; zero-I/O boundary passes.

- [x] **Step 5: Commit the domain contracts.**

Stage only `CONTEXT.md` and the core files changed in this task. Use `superpowers:commit-rebase-pr` with subject `feat(core): define identity and room join contracts`; include the checked focused-test list and an AI review summary covering contract compatibility, zero-I/O risk, and reviewer focus.

### Task 2: Build durable, refreshable, revocable human sessions

**Files:**

- Create: `packages/server/src/state-store.ts`
- Create: `packages/server/src/state-store.test.ts`
- Create: `packages/server/src/auth.ts`
- Create: `packages/server/src/auth.test.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Write failing tests for atomic state replacement and authentication lifecycle.**

```ts
const first = createAuthenticationService({
  identities: testIdentityAdapter,
  sessions: createJsonStateStore(sessionPath, isSessionState),
  clock,
  tokenFactory,
});
const issued = await first.login({ accountId: "account-li", secret: "correct" });
expect(issued.actorId).toBe("human-li");

const afterServerRestart = createAuthenticationService({
  identities: testIdentityAdapter,
  sessions: createJsonStateStore(sessionPath, isSessionState),
  clock,
  tokenFactory,
});
await expect(afterServerRestart.authenticate(issued.accessToken)).resolves.toMatchObject({
  actorId: "human-li",
});

const rotated = await afterServerRestart.refresh(issued.refreshToken);
await expect(afterServerRestart.refresh(issued.refreshToken)).rejects.toMatchObject({
  status: 403,
  code: "session_revoked",
});
await afterServerRestart.revoke(rotated.accessToken);
await expect(afterServerRestart.authenticate(rotated.accessToken)).rejects.toMatchObject({
  status: 403,
  code: "session_revoked",
});
```

Also assert invalid credentials and tampered random access tokens return status 401, and an access token past `expiresAt` returns 401 without deleting the refresh session.

- [x] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/state-store.test.ts packages/server/src/auth.test.ts`

Expected: imports fail because the state and authentication modules do not exist.

- [x] **Step 3: Implement the state-store seam and atomic JSON adapter.**

```ts
export interface StateStore<T> {
  load(): Promise<T | undefined>;
  save(value: T): Promise<void>;
}

export function createJsonStateStore<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
): StateStore<T>;
```

`save` must serialize writes through a promise queue, write `${filePath}.tmp`, then `rename` it over the target. `load` returns `undefined` only for ENOENT and throws `StateStoreCorruptionError` for invalid JSON or a failed guard. A rejected write must not poison later queued saves.

- [x] **Step 4: Implement the identity adapter and authentication module.**

```ts
export interface IdentityAdapter {
  verify(credentials: LoginCredentials): Promise<{ accountId: string; actorId: string } | undefined>;
}

export interface AuthenticationService {
  login(credentials: LoginCredentials): Promise<IssuedSession>;
  authenticate(accessToken: string): Promise<AuthenticatedPrincipal>;
  refresh(
    refreshToken: string,
    expectedPrincipal?: AuthenticatedPrincipal,
  ): Promise<IssuedSession>;
  revoke(accessToken: string): Promise<void>;
}

export function createScryptIdentityAdapter(
  accounts: readonly PasswordIdentityRecord[],
): IdentityAdapter;
```

Use `scrypt` plus `timingSafeEqual` for credential verification. Generate opaque access/refresh tokens from injected `tokenFactory` (default `randomBytes(32).toString("base64url")`); persist only SHA-256 token hashes. When a socket already has a principal, refresh passes it as `expectedPrincipal` and checks ownership inside the serialized auth mutation before token generation, rotation, or persistence; a mismatch returns 403 without changing either session. Normal refresh rotates and revokes the prior token pair; explicit revoke or refresh replay revokes the token family. Access TTL is 15 minutes and refresh TTL is 30 days by defaults exposed in options; tests use injected values and clock.

- [x] **Step 5: Run GREEN and the existing server tests.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/state-store.test.ts packages/server/src/auth.test.ts packages/server/src/service.test.ts`

Expected: new state/auth tests and existing message tests pass.

- [x] **Step 6: Commit durable authentication.**

Stage only `state-store*`, `auth*`, and `packages/server/src/index.ts`. Commit with subject `feat(server): add durable revocable sessions`; include focused typecheck/test evidence and an AI review summary naming credential handling, token rotation, file persistence, and restart behavior as the impact/risk surface.

### Task 3: Implement room governance, human invitations, agent configuration, and audit

**Files:**

- Create: `packages/server/src/room-lifecycle.ts`
- Create: `packages/server/src/room-lifecycle.test.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Write failing lifecycle tests for the two join paths.**

```ts
const rooms = await createRoomLifecycleService({
  actors: [owner, member, invitee, searchAgent],
  state: createJsonStateStore(roomPath, isRoomLifecycleState),
  clock,
  idFactory,
  tokenFactory,
});
const room = await rooms.createRoom(owner.id, { name: "Alpha room" });
const invitation = await rooms.inviteHuman(owner.id, {
  kind: "human-invitation",
  roomId: room.id,
  inviteeActorId: invitee.id,
});
expect(rooms.getRoom(room.id)?.members).toHaveLength(1);
await rooms.respondToHumanInvitation(invitee.id, invitation.token, "accept");
expect(rooms.getRoom(room.id)?.members).toContainEqual(expect.objectContaining({
  kind: "human",
  actorId: invitee.id,
  role: "member",
}));

await rooms.configureAgent(owner.id, {
  kind: "agent-configuration",
  roomId: room.id,
  agentId: searchAgent.id,
  participation: "active",
  toolPermissions: ["search"],
});
expect(rooms.getRoom(room.id)?.members).toContainEqual(expect.objectContaining({
  kind: "agent",
  actorId: searchAgent.id,
  participation: "active",
  toolPermissions: ["search"],
}));
```

Add rejection coverage proving a declined invite stays terminal and does not create membership. Reopen the service from the same file and assert room, invitation result, membership, and audit entries survive restart.

- [x] **Step 2: Add RED authorization and removal tests.**

```ts
for (const action of [
  () => rooms.renameRoom(member.id, room.id, "forged"),
  () => rooms.archiveRoom(member.id, room.id),
  () => rooms.inviteHuman(member.id, humanInvite),
  () => rooms.removeMember(member.id, room.id, invitee.id),
  () => rooms.configureAgent(member.id, agentConfiguration),
]) {
  await expect(action()).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
}

await rooms.removeMember(owner.id, room.id, invitee.id);
expect(rooms.canAccess(invitee.id, room.id)).toBe(false);
expect(rooms.audit(room.id)).toContainEqual(expect.objectContaining({
  type: "room.member.removed",
  targetActorId: invitee.id,
}));
```

- [x] **Step 3: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/room-lifecycle.test.ts`

Expected: module import fails because room lifecycle does not exist.

- [x] **Step 4: Implement a deep `RoomLifecycleService` interface.**

```ts
export interface RoomLifecycleService {
  createRoom(actorId: string, input: { readonly name: string }): Promise<ManagedRoom>;
  renameRoom(actorId: string, roomId: string, name: string): Promise<ManagedRoom>;
  archiveRoom(actorId: string, roomId: string): Promise<ManagedRoom>;
  inviteHuman(actorId: string, request: HumanInvitationRequest): Promise<IssuedHumanInvitation>;
  respondToHumanInvitation(actorId: string, token: string, decision: "accept" | "reject"): Promise<HumanInvitationRecord>;
  configureAgent(actorId: string, request: AgentConfigurationRequest): Promise<ManagedRoom>;
  removeMember(actorId: string, roomId: string, targetActorId: string): Promise<ManagedRoom>;
  canAccess(actorId: string, roomId: string): boolean;
  getActor(actorId: string): Actor | undefined;
  getRoom(roomId: string): ManagedRoom | undefined;
  messageRoom(roomId: string): Room | undefined;
  audit(roomId: string): readonly RoomAuditRecord[];
}
```

Creator becomes owner. `requireManager` accepts only owner/admin for rename, archive, invite, remove, and agent configuration. Human invitation tokens are persisted only as hashes and can be consumed once by the targeted human. Agent permissions must be a subset of the agent actor's declared `toolPermissions`; configuration takes effect without an invitation record. Each successful mutation persists state before returning and appends an audit record with actor, target, result, and timestamp.

- [x] **Step 5: Verify GREEN.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/room-lifecycle.test.ts`

Expected: lifecycle, permission, restart, and audit tests pass.

- [x] **Step 6: Commit room lifecycle governance.**

Stage only `room-lifecycle*` and the server export change. Commit with subject `feat(server): govern room membership lifecycle`; include focused test evidence and an AI review summary naming permission checks, invite consumption, agent grants, removal, and audit as the impact/risk surface.

### Task 4: Make message and WebSocket access derive identity from sessions

**Files:**

- Modify: `packages/server/src/service.ts`
- Modify: `packages/server/src/service.test.ts`
- Modify: `packages/server/src/protocol.ts`
- Modify: `packages/server/src/websocket.ts`
- Modify: `packages/server/src/websocket.test.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Write failing message-module tests for authenticated authorship and all three access gates.**

```ts
const service = createMessageService({ directory: rooms, store, clock });
await service.send(owner.id, draft);
expect(store.messages[0]).toMatchObject({
  authorId: owner.id,
  authorKind: "human",
});

await expect(service.history(nonMember.id, room.id)).rejects.toMatchObject({
  status: 403,
  code: "room_forbidden",
});
expect(() => service.subscribe(nonMember.id, room.id, listener)).toThrow(expect.objectContaining({
  status: 403,
  code: "room_forbidden",
}));
await expect(service.send(nonMember.id, draft)).rejects.toMatchObject({
  status: 403,
  code: "room_forbidden",
});
```

Send one message as a member, remove that member, then assert the owner still reads the old message while the removed member fails send/history/subscribe and the directory no longer includes them.

- [x] **Step 2: Write failing WebSocket tests for two logins, restart resume, token revoke, and actor forgery.**

```ts
const lionel = await LoopbackClient.connect(server.url);
const ada = await LoopbackClient.connect(server.url);
const lionelSession = await lionel.login("account-li", "correct");
await ada.login("account-ada", "correct");

await lionel.send({
  type: "message.send",
  requestId: "forged",
  message: { ...draft, authorId: "human-ada" },
});
await expect(lionel.waitForError("identity_forbidden", "forged")).resolves.toMatchObject({
  frame: { status: 401 },
});

await stopServer();
const restarted = await startFixtureFromSameFiles();
const resumed = await LoopbackClient.connect(restarted.url);
await expect(resumed.resume(lionelSession.accessToken)).resolves.toMatchObject({
  frame: { type: "auth.authenticated", actorId: "human-li" },
});
await resumed.revoke();
const rejected = await LoopbackClient.connect(restarted.url);
await expect(rejected.resume(lionelSession.accessToken)).resolves.toMatchObject({
  frame: { type: "error", status: 403, code: "session_revoked" },
});
```

Before authentication, `message.send`, `room.history`, and `room.subscribe` each return status 401. After authenticating a non-member, the same three operations each return status 403.

- [x] **Step 3: Run RED and confirm it fails on the old trusted-author interface.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/service.test.ts packages/server/src/websocket.test.ts`

Expected: compile/test failures show the old service accepts a full `Message` and the old protocol has no authentication frames.

- [x] **Step 4: Replace the message interface with server-derived authorship.**

```ts
export interface MessageDirectory {
  getActor(actorId: string): Actor | undefined;
  messageRoom(roomId: string): Room | undefined;
}

export interface MessageService {
  send(actorId: string, draft: MessageDraft): Promise<MessageAcceptedAck>;
  subscribe(actorId: string, roomId: string, listener: MessageListener): () => void;
  history(actorId: string, roomId: string): Promise<readonly Message[]>;
}
```

`send` validates the strict draft, resolves the actor and current room membership through `MessageDirectory`, constructs the authoritative `Message`, persists, then ACKs and fans out. History and subscribe use the same current membership check. `RoomAccessError` carries `status: 403` and `code: "room_forbidden"`.

- [x] **Step 5: Add strict authentication and room frames.**

```ts
export type ClientFrame =
  | { readonly type: "auth.login"; readonly requestId: string; readonly accountId: string; readonly secret: string }
  | { readonly type: "auth.resume"; readonly requestId: string; readonly accessToken: string }
  | { readonly type: "auth.refresh"; readonly requestId: string; readonly refreshToken: string }
  | { readonly type: "auth.revoke"; readonly requestId: string }
  | { readonly type: "message.send"; readonly requestId: string; readonly message: MessageDraft }
  | { readonly type: "room.history"; readonly requestId: string; readonly roomId: string }
  | { readonly type: "room.subscribe"; readonly requestId: string; readonly roomId: string };
```

`StartMessageWebSocketServerOptions` receives both `auth` and `service`. Each socket owns at most one authenticated principal. Auth frames establish/rotate/revoke it. Non-auth frames without a principal return `{ type:"error", status:401, code:"unauthenticated" }`; invalid/tampered tokens and client-supplied author fields return 401, while revoked tokens and room access failures return 403. Keep subscription registration-before-history ordering for `room.subscribe`, and make `room.history` a separate one-shot query.

- [x] **Step 6: Run GREEN and regression suites.**

Run: `pnpm typecheck && pnpm exec vitest run packages/server/src/service.test.ts packages/server/src/websocket.test.ts`

Expected: authenticated/restart/forgery/revoke and three-entry authorization tests pass; the original persistence-before-ACK, three-client fan-out, and history/live race tests remain green with session setup added.

- [x] **Step 7: Commit authenticated transport.**

Stage only the message/protocol/WebSocket sources and tests plus server exports. Commit with subject `feat(server): derive message identity from sessions`; include focused and regression evidence and an AI review summary naming the breaking frame contract, 401/403 mapping, current-membership checks, and subscription ordering.

### Task 5: Render different human invitation and agent configuration entry modules

**Files:**

- Modify: `packages/desktop/src/renderer/app.ts`
- Modify: `packages/desktop/src/renderer/app.test.ts`
- Modify: `packages/desktop/src/renderer/styles.css`
- Modify: `packages/desktop/src/renderer/main.ts`

- [x] **Step 1: Write a failing DOM/interaction test for separate entry modules and typed submissions.**

```ts
const humanRequests: HumanInvitationRequest[] = [];
const agentRequests: AgentConfigurationRequest[] = [];
renderRoomJoinControls(root, {
  roomId: "room-1",
  agents: [searchAgent],
  onInviteHuman: (request) => humanRequests.push(request),
  onConfigureAgent: (request) => agentRequests.push(request),
});

expect(root.querySelector("[data-join-kind='human-invitation']")).not.toBeNull();
expect(root.querySelector("[data-join-kind='agent-configuration']")).not.toBeNull();
expect(root.querySelector("[data-join-kind='human-invitation']")?.textContent).toContain("等待对方接受");
expect(root.querySelector("[data-join-kind='agent-configuration']")?.textContent).toContain("参与度");
expect(root.querySelector("[data-join-kind='agent-configuration']")?.textContent).toContain("工具权限");
```

Submit the human form and assert only `humanRequests` receives `{ kind:"human-invitation" }`. Submit the agent form and assert only `agentRequests` receives `{ kind:"agent-configuration", participation, toolPermissions }`.

- [x] **Step 2: Run RED.**

Run: `pnpm typecheck && pnpm exec vitest run packages/desktop/src/renderer/app.test.ts`

Expected: function-existence or DOM assertions fail because room join controls do not exist.

- [x] **Step 3: Implement the functionalist two-column desktop module.**

```ts
export interface RoomJoinControlOptions {
  readonly roomId: string;
  readonly agents: readonly AgentActor[];
  readonly onInviteHuman: (request: HumanInvitationRequest) => void;
  readonly onConfigureAgent: (request: AgentConfigurationRequest) => void;
}

export function renderRoomJoinControls(root: HTMLElement, options: RoomJoinControlOptions): void;
```

Human entry uses a visible actor-id field, `邀请真人` submit action, and explicit pending/accept/reject explanation. Agent entry uses agent selection, participation selection, permission checkboxes derived from the selected agent's declared permissions, and `配置 Agent` submit action. Use existing CSS variables, 44px minimum controls, dark-mode tokens, no decorative animation, and distinct dashed human versus solid agent surfaces. Add `?join-review` preview routing in `main.ts` without replacing the existing empty/chat visual-review paths.

- [x] **Step 4: Run GREEN and build desktop.**

Run: `pnpm typecheck && pnpm exec vitest run packages/desktop/src/renderer/app.test.ts && pnpm --filter @native-im/desktop build`

Expected: both entry modules and callbacks pass JSDOM tests; desktop build succeeds.

- [x] **Step 5: Commit the two entry modules.**

Stage only the four renderer files. Commit with subject `feat(desktop): separate human invite and agent setup`; include DOM/build evidence and an AI review summary naming accessibility, human/agent visual separation, typed payloads, dark mode, and desktop-only scope.

### Task 6: Document the contract, self-review, and deliver T-0039

**Files:**

- Create: `docs/protocols/identity-room-lifecycle.md`
- Create: `docs/deliveries/T-0039-真实身份群与加入生命周期-交付说明.md`
- Modify: this plan's checkboxes as execution evidence is recorded

- [x] **Step 1: Write the normative protocol document.**

It must state the account → session → human actor derivation; access/refresh TTL and rotation; 401 versus 403 rules; human invitation versus agent configuration contracts; owner/admin operations; removal semantics; audit event list; JSON state limitations; and the exact T-0040 handoff for unified persistence/migrations/outbox.

- [x] **Step 2: Self-review every changed file against the six criteria and Acceptance General.**

Check:

```text
[ ] No WebSocket frame or public message method can select authorId/authorKind
[ ] Login, refresh, revoke, expiry, server restart, and new-client resume have tests
[ ] Human invitation and agent configuration differ in data/interface/renderer
[ ] Owner/admin checks execute inside RoomLifecycleService
[ ] Non-member history/subscribe/send each have 403 tests; unauthenticated versions have 401 tests
[ ] Removal preserves historical messages for remaining members and adds an audit record
[ ] Core has no I/O dependency or import
[ ] No .skip/.only; every @ts-expect-error explains the intended compile failure
```

- [x] **Step 3: Run the complete mandatory gate in prescribed order.**

Run: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: all five commands exit 0 with no warnings; core boundary passes; no skipped tests.

- [x] **Step 4: Run Blueprint validation.**

Run: `python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py check /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html --links`

Expected: zero violations and zero dead links. The expected health warning is that the ready pool is empty while T-0039 is actively claimed; explain it in the delivery note rather than hiding it.

- [x] **Step 5: Write the four-section delivery note and verify artifact paths.**

The note must include: one-sentence result; six criterion-by-criterion outcomes with file/test evidence; Buzz reference/translation/deviation; T-0040 unlock. Add the mandatory self-test checklist, the standalone-test baseline ordering observation, and any criteria-tighten suggestion without changing T-0039 criteria.

Run: `test -f docs/protocols/identity-room-lifecycle.md && test -f docs/deliveries/T-0039-真实身份群与加入生命周期-交付说明.md && git diff --check`

Expected: all artifacts exist and diff check emits no output.

- [x] **Step 6: Commit documentation, publish the review branch, then deliver only to `delivered`.**

Stage only the protocol, delivery note, and executed plan. Commit with subject `docs: document T-0039 identity lifecycle`; the body includes the final checked self-test list and AI review summary. Use `superpowers:commit-rebase-pr` for commit/push/PR operations. Do not merge before @lionel verifies T-0039.

After push, create a ready-for-review PR against `main`. Read its exact URL back from GitHub, open it to verify it resolves, and use that exact URL for both the runnable-code artifact and the delivery-note file link on the pushed branch. Then execute `gbp.py set` with `--state delivered --awaiting @lionel`, the two verified HTTPS artifacts, and note `解锁 T-0040；等待 @lionel 验收后再合入 main、清理 worktree / 分支`.

Expected: T-0039 is `delivered`, never `verified`; stop and report to @lionel.
