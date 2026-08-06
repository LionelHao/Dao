# T-0011 Message Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Node/TypeScript message service that durably accepts room messages before ACK, separates historical query from live subscription without loss, and renders human and agent messages as distinct semantic forms.

**Architecture:** `@native-im/core` remains a zero-I/O definition package. A new `@native-im/server` package owns file-backed persistence, membership validation, a WebSocket protocol, and subscription registration; it sends ACK only after the append resolves, then fans out. The Electron renderer consumes protocol-shaped message data and renders a human bubble versus an agent role-colour rail; it does not invent later primitives such as read receipts, mentions, editing, or recall.

**Tech Stack:** TypeScript 5, Node 22, `ws`, Electron, Vitest, JSDOM, pnpm workspace.

---

## Inputs and boundaries

- T-0011 acceptance requires: persisted-before-ACK; three connected clients receive live delivery in under one second; historical query and future subscription have no loss race; three human plus four agent identities can send through one room; a buzz reference/deviation record.
- The affected primitive is message authorship and order: a human message is an editable social utterance in later work, while an agent message is an immutable execution record. This task only establishes the separate data tag, API validation, and visual treatment; edit/recall policy belongs to T-0014.
- Refer to `buzz-relay` shared ingest/`dispatch_persistent_event` for the persistence-before-OK ordering, and `SubscriptionRegistry::register_scoped` for registering future delivery before historical reads. Do not adopt Nostr signing, tenant routing, Redis, workflows, or a global agent queue: V1 is a single local room server.

## File structure

- Modify: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json` — register and build the new server package.
- Modify: `packages/core/src/index.ts`, `packages/core/src/index.test.ts` — add explicit message event and acknowledgement guards while keeping no I/O imports/dependencies.
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/{index,protocol,store,service,websocket}.ts` — transport-independent delivery pipeline plus WebSocket adapter.
- Create: `packages/server/src/{service,websocket}.test.ts` — unit and real-loopback integration coverage.
- Modify: `packages/desktop/package.json`, `packages/desktop/tsconfig.json`, `packages/desktop/src/renderer/{app,app.test,styles}.ts` — semantic message timeline only; desktop connection bootstrapping is deliberately excluded until authentication/session selection exists.
- Create: `docs/protocols/message-ack.md` — normative ACK meaning and client de-duplication rule.

### Task 1: Define explicit message transport contracts in core

**Files:**

- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`
- Test: `packages/core/src/index.test.ts`

- [ ] **Step 1: Write a failing guard test for a persisted acceptance ACK.**

```ts
expect(domain.isMessageAcceptedAck?.({
  type: "message.accepted",
  requestId: "req-1",
  messageId: "message-1",
  persistedAt: "2026-08-06T00:00:00.000Z",
})).toBe(true);
expect(domain.isMessageAcceptedAck?.({
  type: "message.accepted",
  requestId: "req-1",
  messageId: "message-1",
})).toBe(false);
```

- [ ] **Step 2: Run the focused test and verify it fails because the guard is absent.**

Run: `pnpm exec vitest run packages/core/src/index.test.ts`

Expected: a failed assertion that `isMessageAcceptedAck` is not a function.

- [ ] **Step 3: Add the smallest pure type and guard.**

```ts
export interface MessageAcceptedAck {
  readonly type: "message.accepted";
  readonly requestId: string;
  readonly messageId: string;
  readonly persistedAt: string;
}

export function isMessageAcceptedAck(value: unknown): value is MessageAcceptedAck {
  return isRecord(value) && value.type === "message.accepted" &&
    hasString(value, "requestId") && hasString(value, "messageId") && hasString(value, "persistedAt");
}
```

- [ ] **Step 4: Re-run the focused test and the zero-I/O verifier.**

Run: `pnpm exec vitest run packages/core/src/index.test.ts && pnpm verify:core-boundary`

Expected: test passes and the core boundary reports no I/O dependencies or imports.

### Task 2: Build the persist-before-ACK delivery service

**Files:**

- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/store.ts`
- Create: `packages/server/src/service.ts`
- Create: `packages/server/src/service.test.ts`
- Modify: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`

- [ ] **Step 1: Write a failing service test that observes append before ACK and validates author membership.**

```ts
const calls: string[] = [];
const store: MessageStore = {
  append: async (message) => { calls.push(`append:${message.id}`); },
  list: async () => [],
};
const service = createMessageService({ actors, rooms, store, clock: () => "2026-08-06T00:00:00.000Z" });

await expect(service.send(validHumanMessage)).resolves.toMatchObject({ type: "message.accepted" });
expect(calls).toEqual(["append:message-1"]);
await expect(service.send({ ...validHumanMessage, authorId: "unknown" })).rejects.toMatchObject({ code: "unknown_author" });
```

- [ ] **Step 2: Run the focused test and verify it fails because `createMessageService` is absent.**

Run: `pnpm exec vitest run packages/server/src/service.test.ts`

Expected: module/function-not-found failure.

- [ ] **Step 3: Implement the service and a JSONL-backed store.**

```ts
export interface MessageStore {
  append(message: Message): Promise<void>;
  list(roomId: string): Promise<readonly Message[]>;
}

export interface MessageService {
  send(message: Message): Promise<MessageAcceptedAck>;
  subscribe(roomId: string, listener: (message: Message) => void): () => void;
  history(roomId: string): Promise<readonly Message[]>;
}
```

`send` must reject malformed records, mismatched `authorKind`, unknown actors, non-members, and blank bodies; await `store.append(message)`; construct the ACK; then synchronously call current room listeners. The JSONL store must append one JSON record per accepted message and reconstruct only the requested room in `list`.

- [ ] **Step 4: Add a restart persistence assertion and verify the service tests.**

```ts
const afterRestart = await createJsonlMessageStore(filePath).list(room.id);
expect(afterRestart.map((message) => message.id)).toEqual(["message-1"]);
```

Run: `pnpm exec vitest run packages/server/src/service.test.ts`

Expected: all service tests pass.

### Task 3: Add the WebSocket boundary and race-safe history/live protocol

**Files:**

- Create: `packages/server/src/protocol.ts`
- Create: `packages/server/src/websocket.ts`
- Create: `packages/server/src/websocket.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/package.json`

- [ ] **Step 1: Write failing loopback tests for three live clients, seven mixed identities, and subscription race coverage.**

```ts
await Promise.all(clients.slice(0, 3).map((client) => client.subscribe(room.id)));
const receivedAt = await clients[1].waitForMessage("message-human-1");
expect(receivedAt - sentAt).toBeLessThan(1_000);

for (const actor of [...threeHumans, ...fourAgents]) {
  await clientFor(actor).send(messageFor(actor));
}
expect(await historyClient.messages(room.id)).toHaveLength(7);
```

The race test must install a one-shot `afterSubscribeRegistered` hook, send a message from an existing client at that hook, then assert the joining client receives that message either in `message.history` or `message.created`, exactly once after client-side ID de-duplication.

- [ ] **Step 2: Run the focused WebSocket test and verify it fails because no server is listening.**

Run: `pnpm exec vitest run packages/server/src/websocket.test.ts`

Expected: import/start failure, not a timeout.

- [ ] **Step 3: Implement the minimal JSON protocol.**

```ts
type ClientFrame =
  | { readonly type: "message.send"; readonly requestId: string; readonly message: Message }
  | { readonly type: "room.subscribe"; readonly requestId: string; readonly roomId: string };

type ServerFrame =
  | MessageAcceptedAck
  | { readonly type: "message.created"; readonly message: Message }
  | { readonly type: "message.history"; readonly requestId: string; readonly roomId: string; readonly messages: readonly Message[] }
  | { readonly type: "error"; readonly requestId?: string; readonly code: string; readonly message: string };
```

On `room.subscribe`, call `service.subscribe` before awaiting `service.history`, then send `message.history`. A client can receive a live event before the history frame; consumers must de-duplicate by `message.id`. This ordering deliberately translates Buzz's register-future-subscription-before-history-query invariant without copying its tenant or Redis machinery.

- [ ] **Step 4: Re-run the integration suite.**

Run: `pnpm exec vitest run packages/server/src/websocket.test.ts`

Expected: three-client under-one-second fan-out, seven-author end-to-end delivery, persisted ACK ordering, history retrieval, and race test all pass.

### Task 4: Render human and agent messages as distinct semantics

**Files:**

- Modify: `packages/desktop/src/renderer/app.ts`
- Modify: `packages/desktop/src/renderer/app.test.ts`
- Modify: `packages/desktop/src/renderer/styles.css`

- [ ] **Step 1: Write a failing DOM test for the two visual forms.**

```ts
renderMessageTimeline(root, [humanMessage, agentMessage], actorsById);
expect(root.querySelector("[data-message-kind='human'] .message-bubble")).not.toBeNull();
expect(root.querySelector("[data-message-kind='agent'] .message-role-rail")).not.toBeNull();
expect(root.querySelector("[data-message-kind='human'] .message-role-rail")).toBeNull();
```

- [ ] **Step 2: Run the focused renderer test and verify it fails because `renderMessageTimeline` is absent.**

Run: `pnpm exec vitest run packages/desktop/src/renderer/app.test.ts`

Expected: failed function-existence assertion.

- [ ] **Step 3: Implement the smallest renderer.**

```ts
export function renderMessageTimeline(
  root: HTMLElement,
  messages: readonly Message[],
  actorsById: ReadonlyMap<string, Actor>,
): void {
  const timeline = document.createElement("section");
  timeline.dataset.testid = "message-timeline";
  for (const message of messages) timeline.append(renderMessage(message, actorsById.get(message.authorId)));
  root.replaceChildren(timeline);
}
```

Render `human` as `.message.message--human` with a `.message-bubble`; render `agent` as `.message.message--agent` with a `.message-role-rail`, role label, and its own rounded-square avatar class. Do not render typing dots, shared presence, edit controls, or recall controls: those are separate primitives with separate contracts.

- [ ] **Step 4: Re-run renderer tests and inspect the built static desktop screen.**

Run: `pnpm exec vitest run packages/desktop/src/renderer/app.test.ts && pnpm --filter @native-im/desktop build`

Expected: JSDOM proves distinct DOM; Electron build contains the timeline assets.

### Task 5: Document ACK semantics and execute final verification

**Files:**

- Create: `docs/protocols/message-ack.md`
- Create: `docs/deliveries/T-0011-消息基础设施与人agent视觉分离-交付说明.md`

- [ ] **Step 1: Write the ACK contract.**

The document must state: `message.accepted` means server validation passed and the message has been appended to the configured durable store. It does not mean another client has received the message, a future worker reacted, or an agent produced an answer. It must state the subscription registration-before-history ordering and the required client de-duplication key (`Message.id`).

- [ ] **Step 2: Run the complete required gate from a fresh clone of the branch.**

Run: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: all commands exit 0, with no skipped tests or lint warnings.

- [ ] **Step 3: Run blueprint validation and prepare the four-section delivery report.**

Run: `python3 /Users/lionel/project/articles/prd/drafts/context/gbp.py check /Users/lionel/project/articles/prd/drafts/2026-08-原生人机协作IM-蓝图.html --links`

Expected: no violations and no dead links. The delivery report must map every T-0011 criterion to evidence, identify `buzz-relay` ingest/dispatch and subscription registration as references, explain the single-room TypeScript/file-store deviation, and name T-0012, T-0013, T-0014, T-0037, and T-0038 as unlocked.

## Plan self-review

- **Coverage:** Task 2 implements persisted-before-ACK; Task 3 covers all real-time, race, historical, and 3-human/4-agent requirements; Task 4 covers the human/agent data-to-rendering distinction; Task 5 records the required ACK and delivery evidence.
- **Scope:** no Nostr, tenant, Redis, workflow, agents' invocation router, mention semantics, read receipts, recall, or membership UI is introduced.
- **Consistency:** all server writes enter through `MessageService.send`; every transport path uses `Message`, `MessageAcceptedAck`, and the same `MessageStore`; client de-duplication is specified using `Message.id`.
