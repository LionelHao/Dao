import type {
  ActiveHumanMessage,
  MessageAuthorityEvent,
} from "@native-im/core";
import { describe, expect, it, vi } from "vitest";

import {
  MessageAuthorityClientFailure,
  createMessageAuthorityController,
  type MessageAuthorityClientPort,
} from "./controller.js";
import type { MessageAuthorityPortInput } from "./contracts.js";

const createdAt = "2026-08-19T08:00:00.000Z";
const human: ActiveHumanMessage = {
  id: "message-1",
  roomId: "room-1",
  authorId: "human-1",
  authorKind: "human",
  createdAt,
  lifecycle: "active",
  currentRevision: {
    messageId: "message-1", revision: 1, body: "Hello", revisedAt: createdAt,
    revisedByActorId: "human-1",
  },
  revisionCount: 1,
  mentionedTargets: [],
  attachments: [],
  targetOutcomes: [],
};

function clientPort() {
  let listener: ((input: MessageAuthorityPortInput) => void) | undefined;
  let resolveSend!: (value: {
    type: "message.accepted";
    requestId: string;
    messageId: string;
    persistedAt: string;
    targetOutcomes: readonly [];
  }) => void;
  const sendAck = new Promise<Parameters<typeof resolveSend>[0]>((resolve) => {
    resolveSend = resolve;
  });
  const value: MessageAuthorityClientPort = {
    historyV2: vi.fn(async (request) => ({
      type: "room.history.v2", requestId: request.requestId, roomId: request.roomId,
      status: "ready", viewerActorId: "human-1", lifecycle: "active",
      connection: { status: "online" },
      actors: [{ actorId: "human-1", kind: "human", displayName: "Human", secondaryLabel: "Owner" }],
      messages: [human], hasMore: false, generation: 4, watermark: 9,
    })),
    revisionsQuery: vi.fn(async (request) => ({
      type: "message.revisions", requestId: request.requestId, roomId: request.roomId,
      messageId: request.messageId, revisions: [human.currentRevision], hasMore: false,
    })),
    sendV2: vi.fn(() => sendAck),
    revise: vi.fn(async (request) => ({
      type: "message.revision.accepted", requestId: request.requestId,
      messageId: request.messageId, revision: request.expectedRevision + 1,
      persistedAt: "2026-08-19T08:01:00.000Z",
    })),
    recall: vi.fn(async (request) => ({
      type: "message.recall.accepted", requestId: request.requestId,
      messageId: request.messageId, revision: request.expectedRevision,
      recalledAt: "2026-08-19T08:02:00.000Z",
    })),
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
  };
  return { value, resolveSend, publish: (input: MessageAuthorityPortInput) => listener?.(input) };
}

describe("Message Authority main-process controller", () => {
  it("adds requestIds internally and exposes ACK/stable-event correlation without secrets", async () => {
    const client = clientPort();
    let sequence = 0;
    const controller = createMessageAuthorityController({
      client: client.value,
      createRequestId: (operation) => `${operation}-${++sequence}`,
    });
    const inputs: unknown[] = [];
    controller.subscribe((input) => inputs.push(input));

    const history = await controller.historyV2({ type: "room.history.v2", roomId: "room-1" });
    expect(history).toMatchObject({ status: "ready", requestId: "history-1" });
    expect(client.value.historyV2).toHaveBeenCalledWith({
      type: "room.history.v2", requestId: "history-1", roomId: "room-1",
    });

    const receipt = controller.sendV2({
      type: "message.send.v2",
      message: {
        messageId: "message-2", roomId: "room-1", body: "Ask @Agent",
        mentionedTargets: [{
          id: "target-1", kind: "agent-invocation", targetActorId: "agent-1",
          range: { startUtf16: 4, endUtf16: 10 },
        }],
        attachments: [],
      },
    });
    expect(receipt).toEqual({ requestId: "sendV2-2" });
    expect(client.value.sendV2).toHaveBeenCalledWith(expect.objectContaining({
      type: "message.send.v2", requestId: "sendV2-2",
    }));
    expect(JSON.stringify(receipt)).not.toMatch(/token|secret|idempotency/u);

    const acceptedEvent: MessageAuthorityEvent = {
      eventId: "event-message-2", streamKind: "room", streamId: "room-1", streamSeq: 10,
      roomId: "room-1", type: "room.message.accepted", actorId: "human-1", occurredAt: createdAt,
      payload: { ...human, id: "message-2", currentRevision: {
        ...human.currentRevision, messageId: "message-2", body: "Ask @Agent",
      } },
    };
    client.publish({ type: "room.event", cursorBefore: 9, generation: 4, event: acceptedEvent });
    expect(inputs.at(-1)).toMatchObject({ type: "room.event", event: { eventId: "event-message-2" } });

    client.resolveSend({
      type: "message.accepted", requestId: "sendV2-2", messageId: "message-2",
      persistedAt: createdAt, targetOutcomes: [],
    });
    await vi.waitFor(() => expect(inputs).toContainEqual(expect.objectContaining({
      type: "message.accepted", requestId: "sendV2-2",
    })));
    controller.close();
  });

  it("maps a closed 410 failure and rejects mismatched or unclosed authority responses", async () => {
    const client = clientPort();
    client.value.sendV2 = vi.fn(async () => {
      throw new MessageAuthorityClientFailure({
        status: 410, code: "protocol_upgrade_required",
      });
    });
    const controller = createMessageAuthorityController({
      client: client.value,
      createRequestId: () => "request-upgrade",
    });
    const inputs: unknown[] = [];
    controller.subscribe((input) => inputs.push(input));
    controller.sendV2({
      type: "message.send.v2",
      message: {
        messageId: "message-2", roomId: "room-1", body: "Hello",
        mentionedTargets: [], attachments: [],
      },
    });
    await vi.waitFor(() => expect(inputs).toEqual([{
      type: "message.error", requestId: "request-upgrade",
      status: 410, code: "protocol_upgrade_required",
    }]));

    client.value.historyV2 = vi.fn(async (request) => ({
      type: "room.history.v2", requestId: `${request.requestId}-wrong`, roomId: request.roomId,
      status: "locked", connection: { status: "fatal", errorCode: "bad" },
    }));
    await expect(controller.historyV2({ type: "room.history.v2", roomId: "room-1" }))
      .rejects.toThrow("response correlation");
    controller.close();
  });
});
