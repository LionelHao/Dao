import type {
  ActiveHumanMessage,
  MessageAuthorityEvent,
} from "@native-im/core";
import { describe, expect, it, vi } from "vitest";

import {
  MessageAuthorityClientFailure,
  createMessageAuthorityController,
  type MessageAuthorityClientPort,
} from "../../message-authority/controller.js";
import type { MessageAuthorityPortInput } from "../../message-authority/contracts.js";
import type {
  AttachmentAuthorityBridge,
  AttachmentAuthorityBridgeInput,
} from "../../attachment-authority/contracts.js";
import { registerMessageAuthorityIpc } from "../../message-authority/ipc.js";
import { createMessageAuthorityBridge } from "../../message-authority/preload-bridge.js";
import { mountMessageAuthorityBridgeSurface } from "./bridge-adapter.js";

const createdAt = "2026-08-19T08:00:00.000Z";

const remoteReadyStatus = {
  type: "attachment.status" as const,
  attachment: {
    attachmentId: "attachment-remote", roomId: "room-1", originalFilename: "跨设备报告.pdf",
    format: "pdf" as const, declaredMime: "application/pdf" as const,
    detectedMime: "application/pdf" as const, byteSize: 65_536, sha256: "a".repeat(64),
    uploaderActorId: "human-1", createdAt, readyAt: "2026-08-19T08:01:00.000Z",
    processingStatus: "ready" as const, generation: 2, sourceMessageId: null,
    provenance: {
      scanner: { kind: "clamav" as const, version: "1.4.3" },
      extraction: { method: "pdf-text" as const, tool: "pdftotext" as const,
        version: "25.06.0", artifactSha256: "b".repeat(64), artifactByteSize: 1_024, pageCount: 2 },
      ocr: null,
    },
  },
  sourceEligibility: "unbound" as const,
  accessProjection: "authorized" as const,
};

function privateStatus(attachmentId: string) {
  return {
    ...remoteReadyStatus,
    attachment: { ...remoteReadyStatus.attachment, attachmentId },
  };
}

function attachmentHarness(): { readonly bridge: AttachmentAuthorityBridge } {
  return { bridge: {
    select: vi.fn(async () => ({ status: "cancelled" as const })),
    upload: vi.fn(async () => ({ operationId: "upload-1" })),
    cancel: vi.fn(async () => ({ operationId: "cancel-1" })),
    retryProcessing: vi.fn(async () => ({ operationId: "retry-1" })),
    status: vi.fn(async () => remoteReadyStatus),
    preview: vi.fn(async ({ attachmentId, representation }) => ({
      type: "attachment.preview.policy" as const, attachmentId, representation,
      nodeIntegration: false as const, contextIsolation: true as const, sandbox: true as const,
      webSecurity: true as const, allowNavigation: false as const, allowWindowOpen: false as const,
      allowPermissions: false as const, allowExternalProtocols: false as const,
      allowNetwork: false as const, ariaLive: "off" as const,
    })),
    download: vi.fn(async ({ attachmentId }) => ({
      type: "attachment.download.saved" as const, attachmentId,
    })),
    removeSelection: vi.fn(async () => undefined),
    onAuthorityInput: () => () => undefined,
  } };
}

function human(id: string, body: string): ActiveHumanMessage {
  return {
    id,
    roomId: "room-1",
    authorId: "human-1",
    authorKind: "human",
    createdAt,
    lifecycle: "active",
    currentRevision: {
      messageId: id,
      revision: 1,
      body,
      revisedAt: createdAt,
      revisedByActorId: "human-1",
    },
    revisionCount: 1,
    mentionedTargets: [],
    attachments: [],
    targetOutcomes: [],
  };
}

function acceptedEvent(sequence: number, id: string, body: string): MessageAuthorityEvent {
  return {
    eventId: `event-${sequence}`,
    streamKind: "room",
    streamId: "room-1",
    streamSeq: sequence,
    roomId: "room-1",
    type: "room.message.accepted",
    actorId: "human-1",
    occurredAt: createdAt,
    payload: human(id, body),
  };
}

function revisedEvent(sequence: number, revision: number, body: string): MessageAuthorityEvent {
  return {
    eventId: `event-revised-${sequence}`, streamKind: "room", streamId: "room-1",
    streamSeq: sequence, roomId: "room-1", type: "room.message.revised",
    actorId: "human-1", occurredAt: createdAt,
    payload: { ...human("message-existing", body), revisionCount: revision,
      currentRevision: { ...human("message-existing", body).currentRevision, revision, body } },
  };
}

function recalledEvent(sequence: number, messageId = "message-existing"): MessageAuthorityEvent {
  return {
    eventId: `event-recalled-${sequence}`, streamKind: "room", streamId: "room-1",
    streamSeq: sequence, roomId: "room-1", type: "room.message.recalled",
    actorId: "human-1", occurredAt: createdAt,
    payload: { id: messageId, roomId: "room-1", authorId: "human-1",
      authorKind: "human", createdAt, lifecycle: "recalled", recalledAt: createdAt,
      revisionCount: 2 },
  };
}

interface DeferredSend {
  readonly requestId: string;
  resolve(): void;
  reject(error: unknown): void;
}

function authorityHarness() {
  let portListener: ((input: MessageAuthorityPortInput) => void) | undefined;
  const deferred: DeferredSend[] = [];
  const port: MessageAuthorityClientPort = {
    historyV2: vi.fn(async (request) => ({
      type: "room.history.v2",
      requestId: request.requestId,
      roomId: "room-1",
      status: "ready",
      viewerActorId: "human-1",
      lifecycle: "active",
      connection: { status: "online" },
      actors: [
        { actorId: "human-1", kind: "human", displayName: "Sam", secondaryLabel: "Owner" },
        { actorId: "agent-1", kind: "agent", displayName: "Sam", secondaryLabel: "Planner" },
      ],
      messages: [human("message-existing", "Existing authority message")],
      hasMore: false,
      generation: 4,
      watermark: 9,
    })),
    revisionsQuery: vi.fn(async (request) => ({
      type: "message.revisions",
      requestId: request.requestId,
      roomId: request.roomId,
      messageId: request.messageId,
      revisions: [human(request.messageId, "Existing authority message").currentRevision],
      hasMore: false,
    })),
    sendV2: vi.fn((request) => new Promise((resolve, reject) => {
      deferred.push({
        requestId: request.requestId,
        resolve: () => resolve({
          type: "message.accepted",
          requestId: request.requestId,
          messageId: request.message.messageId,
          persistedAt: createdAt,
          targetOutcomes: [],
        }),
        reject,
      });
    })),
    revise: vi.fn(async (request) => ({
      type: "message.revision.accepted",
      requestId: request.requestId,
      messageId: request.messageId,
      revision: request.expectedRevision + 1,
      persistedAt: createdAt,
    })),
    recall: vi.fn(async (request) => ({
      type: "message.recall.accepted",
      requestId: request.requestId,
      messageId: request.messageId,
      revision: request.expectedRevision,
      recalledAt: createdAt,
    })),
    subscribe(listener) {
      portListener = listener;
      return () => { portListener = undefined; };
    },
  };

  let requestSequence = 0;
  const controller = createMessageAuthorityController({
    client: port,
    createRequestId: (operation) => `${operation}-${++requestSequence}`,
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const rendererListeners = new Map<string, (event: unknown, input: unknown) => void>();
  const frame = {};
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
    send(channel: string, input: unknown) {
      rendererListeners.get(channel)?.({}, input);
    },
  };
  const disposeIpc = registerMessageAuthorityIpc({
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    webContents,
    controller,
  });
  const bridge = createMessageAuthorityBridge({
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error("missing handler");
      return handler({ sender: webContents, senderFrame: frame }, ...args);
    },
    on(channel, listener) { rendererListeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (rendererListeners.get(channel) === listener) rendererListeners.delete(channel);
    },
  });
  return {
    bridge,
    port,
    deferred,
    publish: (input: MessageAuthorityPortInput) => portListener?.(input),
    close() { disposeIpc(); controller.close(); },
  };
}

function composer(root: HTMLElement): HTMLTextAreaElement {
  return root.querySelector<HTMLTextAreaElement>("[data-message-composer]")!;
}

function send(root: HTMLElement): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>("[data-action='send-message']")!;
}

describe("Message Authority bridge renderer adapter", () => {
  it("renders transient wire previews and removes them on reset without creating timeline facts", async () => {
    const authority = authorityHarness();
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-new",
      createTargetId: () => "target-new",
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));

    authority.publish({ type: "agent.execution.preview", roomId: "room-1",
      executionId: "execution-1", attemptSeq: 1, streamSeq: 1,
      delta: "FT08-PREVIEW-TRANSIENT-ONLY-7F41C9D2", authoritative: false });
    await vi.waitFor(() => expect(root.querySelector("[data-agent-preview='execution-1']")?.textContent)
      .toContain("FT08-PREVIEW-TRANSIENT-ONLY-7F41C9D2"));
    expect(root.querySelectorAll("[data-message-id]")).toHaveLength(1);

    authority.publish({ type: "agent.execution.preview.reset", roomId: "room-1",
      executionId: "execution-1", attemptSeq: 1,
      reason: "human_cancelled", authoritative: false });
    await vi.waitFor(() => expect(root.querySelector("[data-agent-preview='execution-1']")).toBeNull());
    expect(root.textContent).not.toContain("FT08-PREVIEW-TRANSIENT-ONLY-7F41C9D2");
    authority.publish({ type: "agent.execution.preview", roomId: "room-1",
      executionId: "execution-1", attemptSeq: 2, streamSeq: 1,
      delta: "DISCONNECT-SENTINEL", authoritative: false });
    await vi.waitFor(() => expect(root.textContent).toContain("DISCONNECT-SENTINEL"));
    authority.publish({ type: "message.connection", roomId: "room-1",
      connection: { status: "offline", asOf: createdAt } });
    await vi.waitFor(() => expect(root.querySelector("[data-agent-preview='execution-1']")).toBeNull());
    expect(root.textContent).toContain("Existing authority message");
    dispose();
    authority.close();
  });

  it("advances across non-message Room events without adding a timeline row", async () => {
    const authority = authorityHarness();
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-new",
      createTargetId: () => "target-new",
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));

    authority.publish({
      type: "room.cursor.advanced",
      roomId: "room-1",
      cursorBefore: 9,
      generation: 4,
      eventId: "room-renamed-10",
      streamSeq: 10,
    });
    authority.publish({
      type: "room.event",
      cursorBefore: 10,
      generation: 4,
      event: acceptedEvent(11, "message-after-rename", "After rename"),
    });

    await vi.waitFor(() => expect(root.textContent).toContain("After rename"));
    expect(root.textContent).not.toContain("event_cursor_mismatch");
    expect(root.querySelectorAll("[data-message-id]")).toHaveLength(2);
    dispose();
    authority.close();
  });

  it("runs real send controls through the closed bridge and converges every ACK/event order", async () => {
    const authority = authorityHarness();
    const root = document.createElement("main");
    let messageSequence = 0;
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => `message-new-${++messageSequence}`,
      createTargetId: () => `target-${messageSequence}`,
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));

    composer(root).value = "Event before ACK";
    composer(root).dispatchEvent(new Event("input", { bubbles: true }));
    send(root).click();
    await vi.waitFor(() => expect(authority.port.sendV2).toHaveBeenCalledTimes(1));
    const firstFrame = vi.mocked(authority.port.sendV2).mock.calls[0]![0];
    expect(firstFrame).toMatchObject({
      type: "message.send.v2", requestId: "sendV2-2",
      message: { messageId: "message-new-1", body: "Event before ACK" },
    });
    expect(JSON.stringify(firstFrame)).not.toMatch(/authorId|token|secret|idempotency/u);
    authority.publish({
      type: "room.event", cursorBefore: 9, generation: 4,
      event: acceptedEvent(10, "message-new-1", "Event before ACK"),
    });
    await vi.waitFor(() => expect(root.querySelector("[data-submission-status='accepted-via-event']"))
      .not.toBeNull());
    authority.deferred[0]!.resolve();
    await vi.waitFor(() => expect(root.querySelector("[data-submission-status='accepted']"))
      .not.toBeNull());

    composer(root).value = "ACK before event";
    composer(root).dispatchEvent(new Event("input", { bubbles: true }));
    send(root).click();
    await vi.waitFor(() => expect(authority.port.sendV2).toHaveBeenCalledTimes(2));
    authority.deferred[1]!.resolve();
    await vi.waitFor(() => expect(root.querySelector("[data-submission-status='accepted']"))
      .not.toBeNull());
    authority.publish({
      type: "room.event", cursorBefore: 10, generation: 4,
      event: acceptedEvent(11, "message-new-2", "ACK before event"),
    });
    await vi.waitFor(() => expect(root.textContent).toContain("ACK before event"));

    composer(root).value = "ACK lost but event wins";
    composer(root).dispatchEvent(new Event("input", { bubbles: true }));
    send(root).click();
    await vi.waitFor(() => expect(authority.port.sendV2).toHaveBeenCalledTimes(3));
    authority.publish({
      type: "room.event", cursorBefore: 11, generation: 4,
      event: acceptedEvent(12, "message-new-3", "ACK lost but event wins"),
    });
    authority.deferred[2]!.reject(new Error("ack lost"));
    await vi.waitFor(() => expect(root.querySelector("[data-submission-status='accepted-via-event']"))
      .not.toBeNull());
    expect(root.textContent).toContain("ACK lost but event wins");

    dispose();
    authority.close();
  });

  it("fails writes before the port while offline/repairing, keeps old repair state, handles 410, and purges revoke", async () => {
    const authority = authorityHarness();
    const root = document.createElement("main");
    let messageSequence = 0;
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => `message-${++messageSequence}`,
      createTargetId: () => `target-${messageSequence}`,
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));

    authority.publish({
      type: "message.connection", roomId: "room-1",
      connection: { status: "offline", asOf: createdAt },
    });
    expect(send(root).disabled).toBe(true);
    send(root).click();
    expect(authority.port.sendV2).not.toHaveBeenCalled();

    authority.publish({
      type: "message.connection", roomId: "room-1",
      connection: { status: "repairing", watermark: 12 },
    });
    expect(root.textContent).toContain("Existing authority message");
    expect(root.textContent).toContain("staging 不可见");
    authority.publish({
      type: "message.connection", roomId: "room-1",
      connection: { status: "repair-failed", errorCode: "checksum_mismatch" },
    });
    expect(root.textContent).toContain("旧完整 projection");

    authority.publish({
      type: "message.connection", roomId: "room-1", connection: { status: "online" },
    });
    vi.mocked(authority.port.sendV2).mockRejectedValueOnce(
      new MessageAuthorityClientFailure({ status: 410, code: "protocol_upgrade_required" }),
    );
    composer(root).value = "Unsafe client";
    composer(root).dispatchEvent(new Event("input", { bubbles: true }));
    send(root).click();
    await vi.waitFor(() => expect(root.querySelector("[data-message-error='protocol_upgrade_required']"))
      .not.toBeNull());
    expect(root.textContent).toContain("升级客户端");

    authority.publish({
      type: "message.connection", roomId: "room-1",
      connection: { status: "revoked", scope: "room", purgeCompleted: true },
    });
    expect(root.querySelector("[data-message-authority-locked]")).not.toBeNull();
    expect(root.textContent).not.toContain("Existing authority message");
    dispose();
    authority.close();
  });

  it("uses revisions.query before a real revision command and sends recall with the projected revision", async () => {
    const authority = authorityHarness();
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-new",
      createTargetId: () => "target-new",
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));

    root.querySelector<HTMLButtonElement>("[data-action='revise-message']")!.click();
    await vi.waitFor(() => expect(authority.port.revisionsQuery).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(send(root).textContent).toBe("保存修订"));
    composer(root).value = "Actually revised body";
    composer(root).dispatchEvent(new Event("input", { bubbles: true }));
    send(root).click();
    await vi.waitFor(() => expect(authority.port.revise).toHaveBeenCalledWith(expect.objectContaining({
      type: "message.revise", roomId: "room-1", messageId: "message-existing",
      expectedRevision: 1, body: "Actually revised body",
    })));
    await vi.waitFor(() => expect(root.querySelector("[data-mutation-status='acknowledged']"))
      .not.toBeNull());
    expect(root.textContent).toContain("ACK 不会替换 projection");
    expect(root.textContent).toContain("Existing authority message");
    authority.publish({ type: "room.event", cursorBefore: 9, generation: 4,
      event: revisedEvent(10, 2, "Actually revised body") });
    await vi.waitFor(() => expect(root.textContent).toContain("Actually revised body"));
    expect(root.querySelector("[data-mutation-status]")).toBeNull();

    root.querySelector<HTMLButtonElement>("[data-action='recall-message']")!.click();
    expect(authority.port.recall).toHaveBeenCalledWith(expect.objectContaining({
      type: "message.recall", roomId: "room-1", messageId: "message-existing",
      expectedRevision: 2,
    }));
    await vi.waitFor(() => expect(root.querySelector("[data-mutation-status='acknowledged']"))
      .not.toBeNull());
    authority.publish({ type: "room.event", cursorBefore: 10, generation: 4,
      event: recalledEvent(11) });
    await vi.waitFor(() => expect(root.textContent).toContain("消息已撤回"));
    expect(root.textContent).not.toContain("Actually revised body");
    dispose();
    authority.close();
  });

  it("keeps the old complete timeline visible while offline retry performs an atomic restore", async () => {
    const authority = authorityHarness();
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-new",
      createTargetId: () => "target-new",
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));
    authority.publish({ type: "message.connection", roomId: "room-1",
      connection: { status: "offline", asOf: createdAt } });

    let restore: ((value: Awaited<ReturnType<MessageAuthorityClientPort["historyV2"]>>) => void) | undefined;
    let restoreRequestId = "";
    vi.mocked(authority.port.historyV2).mockImplementationOnce((request) => new Promise((resolve) => {
      restoreRequestId = request.requestId;
      restore = resolve;
    }));
    root.querySelector<HTMLButtonElement>("[data-action='reconnect-message-authority']")!.click();
    await vi.waitFor(() => expect(authority.port.historyV2).toHaveBeenCalledTimes(2));
    expect(root.textContent).toContain("Existing authority message");

    expect(root.textContent).toContain("staging 不可见");

    restore!({ type: "room.history.v2", requestId: restoreRequestId, roomId: "room-1",
      status: "ready", viewerActorId: "human-1", lifecycle: "active",
      connection: { status: "online" }, actors: [], messages: [human("message-restored", "Restored")],
      hasMore: false, generation: 5, watermark: 12 });
    await vi.waitFor(() => expect(root.textContent).toContain("Restored"));
    expect(root.textContent).not.toContain("Existing authority message");
    expect(root.querySelector("[data-projection-generation='5']")).not.toBeNull();

    authority.publish({ type: "message.connection", roomId: "room-1",
      connection: { status: "offline", asOf: createdAt } });
    vi.mocked(authority.port.historyV2).mockRejectedValueOnce(
      new MessageAuthorityClientFailure({ status: 503, code: "dependency_unavailable" }),
    );
    root.querySelector<HTMLButtonElement>("[data-action='reconnect-message-authority']")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("REPAIR FAILED"));
    expect(root.textContent).toContain("Restored");
    expect(root.querySelector("[data-projection-generation='5']")).not.toBeNull();
    dispose();
    authority.close();
  });

  it("keeps two-device revise/recall losers visible when the winning event precedes local 409", async () => {
    const authority = authorityHarness();
    let rejectRevise: ((error: unknown) => void) | undefined;
    vi.mocked(authority.port.revise).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRevise = reject;
    }));
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-new",
      createTargetId: () => "target-new",
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));
    root.querySelector<HTMLButtonElement>("[data-action='revise-message']")!.click();
    await vi.waitFor(() => expect(send(root).textContent).toBe("保存修订"));
    composer(root).value = "Losing concurrent revision";
    composer(root).dispatchEvent(new Event("input", { bubbles: true }));
    send(root).click();
    await vi.waitFor(() => expect(authority.port.revise).toHaveBeenCalledOnce());
    authority.publish({ type: "room.event", cursorBefore: 9, generation: 4,
      event: revisedEvent(10, 2, "Winning device revision") });
    await vi.waitFor(() => expect(root.textContent).toContain("Winning device revision"));
    rejectRevise!(new MessageAuthorityClientFailure({
      status: 409, code: "message_version_conflict",
    }));
    await vi.waitFor(() => expect(root.querySelector("[data-mutation-error='message_version_conflict']"))
      .not.toBeNull());
    expect(root.querySelector("[data-mutation-request-id='revise-3']")).not.toBeNull();
    expect(composer(root).value).toBe("Losing concurrent revision");
    expect(root.textContent).toContain("ACK 不会替换 projection");
    expect(root.querySelector("[data-action='refresh-projection']")).not.toBeNull();
    expect(root.textContent).toContain("Winning device revision");

    let rejectRecall: ((error: unknown) => void) | undefined;
    vi.mocked(authority.port.recall).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRecall = reject;
    }));
    root.querySelector<HTMLButtonElement>("[data-action='recall-message']")!.click();
    await vi.waitFor(() => expect(authority.port.recall).toHaveBeenCalledOnce());
    authority.publish({ type: "room.event", cursorBefore: 10, generation: 4,
      event: recalledEvent(11) });
    await vi.waitFor(() => expect(root.textContent).toContain("消息已撤回"));
    rejectRecall!(new MessageAuthorityClientFailure({ status: 409, code: "message_recalled" }));
    await vi.waitFor(() => expect(root.querySelector("[data-mutation-error='message_recalled']"))
      .not.toBeNull());
    expect(root.querySelector("[data-mutation-request-id='recall-4']")).not.toBeNull();
    expect(root.textContent).toContain("消息已撤回");
    expect(root.textContent).not.toContain("Winning device revision");
    expect(root.querySelector("[data-action='refresh-projection']")).not.toBeNull();
    root.querySelector<HTMLButtonElement>("[data-action='refresh-projection']")!.click();
    await vi.waitFor(() => expect(authority.port.historyV2).toHaveBeenCalledTimes(2));
    expect(composer(root).value).toBe("Losing concurrent revision");
    dispose();
    authority.close();
  });

  it("submits only stable READY attachment IDs and exposes bound preview/download through the bridge", async () => {
    const authority = authorityHarness();
    let attachmentListener: ((input: AttachmentAuthorityBridgeInput) => void) | undefined;
    const attachmentBridge: AttachmentAuthorityBridge = {
      select: vi.fn(async () => ({ status: "selected", selection: {
        selectionHandle: "selection-1", displayName: "brief.pdf", format: "pdf",
        declaredMime: "application/pdf", byteSize: 32_768,
        expiresAt: "2026-08-19T12:00:00.000Z",
      } })),
      upload: vi.fn(async () => ({ operationId: "attachment-operation-1" })),
      cancel: vi.fn(async () => ({ operationId: "cancel-1" })),
      retryProcessing: vi.fn(async () => ({ operationId: "retry-1" })),
      status: vi.fn(async ({ attachmentId }) => ({
        ...privateStatus(attachmentId),
        attachment: { ...privateStatus(attachmentId).attachment,
          sourceMessageId: "message-with-attachment" },
        sourceEligibility: "bound-active" as const,
      })),
      preview: vi.fn(async ({ attachmentId, representation }) => ({
        type: "attachment.preview.policy", attachmentId, representation,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        allowNavigation: false, allowWindowOpen: false, allowPermissions: false,
        allowExternalProtocols: false, allowNetwork: false, ariaLive: "off",
      })),
      download: vi.fn(async ({ attachmentId }) => ({
        type: "attachment.download.saved", attachmentId,
      })),
      removeSelection: vi.fn(async () => undefined),
      onAuthorityInput(listener) {
        attachmentListener = listener;
        return () => { attachmentListener = undefined; };
      },
    };
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-with-attachment",
      createTargetId: () => "target-new",
      attachmentBridge,
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Existing authority message"));

    root.querySelector<HTMLButtonElement>("[data-action='select-attachment']")?.click();
    await vi.waitFor(() => expect(root.textContent).toContain("brief.pdf"));
    expect(send(root).disabled).toBe(true);
    expect(send(root).textContent).toBe("等待附件就绪");
    root.querySelector<HTMLButtonElement>("[data-action='upload']")?.click();
    await vi.waitFor(() => expect(attachmentBridge.upload).toHaveBeenCalledOnce());
    attachmentListener?.({
      type: "attachment.upload.accepted", operationId: "attachment-operation-1",
      attachmentId: "attachment-1", processingStatus: "accepted-quarantined",
    });
    expect(send(root).disabled).toBe(true);
    attachmentListener?.(privateStatus("attachment-1"));
    expect(send(root).disabled).toBe(false);

    composer(root).value = "Message with ready attachment";
    composer(root).dispatchEvent(new Event("input", { bubbles: true }));
    send(root).click();
    await vi.waitFor(() => expect(authority.port.sendV2).toHaveBeenCalledOnce());
    expect(vi.mocked(authority.port.sendV2).mock.calls[0]?.[0].message.attachments)
      .toEqual([{ attachmentId: "attachment-1" }]);

    const submittedEvent = acceptedEvent(
      10, "message-with-attachment", "Message with ready attachment",
    );
    authority.publish({ type: "room.event", cursorBefore: 9, generation: 4,
      event: { ...submittedEvent, payload: {
        ...submittedEvent.payload,
        attachments: [{ attachmentId: "attachment-1" }],
      } } });
    authority.deferred[0]?.resolve();
    await vi.waitFor(() => expect(root.querySelector("[data-attachment-composer]")?.textContent)
      .not.toContain("brief.pdf"));

    await vi.waitFor(() => expect(root.querySelector("[data-attachment-id='attachment-1']"))
      .not.toBeNull());
    root.querySelector<HTMLButtonElement>("[data-action='preview-attachment']")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='download-attachment']")?.click();
    expect(attachmentBridge.preview).toHaveBeenCalledWith({
      type: "attachment.preview", attachmentId: "attachment-1", representation: "safe-rendered",
    });
    expect(attachmentBridge.download).toHaveBeenCalledWith({
      type: "attachment.download", attachmentId: "attachment-1",
    });
    dispose();
    authority.close();
  });

  it("rehydrates historical attachment cards through status reauthorization and degrades closed", async () => {
    const authority = authorityHarness();
    const history = {
      type: "room.history.v2", requestId: "history-1", roomId: "room-1", status: "ready",
      viewerActorId: "human-1", lifecycle: "archived", connection: { status: "online" },
      actors: [{ actorId: "human-1", kind: "human", displayName: "Sam", secondaryLabel: "Owner" }],
      messages: [{ ...human("message-history", "Historical attachment"),
        attachments: [{ attachmentId: "attachment-history" }] }],
      hasMore: false, generation: 4, watermark: 9,
    } as const;
    vi.mocked(authority.port.historyV2).mockResolvedValueOnce(history).mockResolvedValueOnce(history);
    const status = vi.fn(async () => ({
      ...remoteReadyStatus,
      attachment: { ...remoteReadyStatus.attachment,
        attachmentId: "attachment-history", sourceMessageId: "message-history" },
      sourceEligibility: "bound-active" as const,
      accessProjection: "archived-read-only" as const,
    }));
    const attachmentBridge = { ...attachmentHarness().bridge, status };
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-new", createTargetId: () => "target-new", attachmentBridge,
    });

    await vi.waitFor(() => expect(status).toHaveBeenCalledWith({
      type: "attachment.status.query", attachmentId: "attachment-history",
    }));
    await vi.waitFor(() => expect(root.textContent).toContain("跨设备报告.pdf"));
    const card = root.querySelector("[data-attachment-id='attachment-history']");
    expect(card?.textContent).not.toContain("attachment-history");
    expect(card?.querySelector("[data-action='preview-attachment']")).not.toBeNull();
    expect(card?.querySelector("[data-action='download-attachment']")).not.toBeNull();
    expect(root.innerHTML).not.toMatch(/path|token|objectKey|extractedText/u);
    expect(root.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
    expect(card?.querySelector("[data-attachment-preview-policy]")?.getAttribute("aria-live"))
      .toBe("off");

    dispose();
    authority.close();
  });

  it("keeps hydrated metadata read-only offline/repairing, reauthenticates again, and purges recall", async () => {
    const authority = authorityHarness();
    const history = {
      type: "room.history.v2", requestId: "history-1", roomId: "room-1", status: "ready",
      viewerActorId: "human-1", lifecycle: "active", connection: { status: "online" },
      actors: [{ actorId: "human-1", kind: "human", displayName: "Sam", secondaryLabel: "Owner" }],
      messages: [{ ...human("message-history", "Historical attachment"),
        attachments: [{ attachmentId: "attachment-history" }] }],
      hasMore: false, generation: 4, watermark: 9,
    } as const;
    vi.mocked(authority.port.historyV2).mockImplementation(async (request) => ({
      ...history, requestId: request.requestId,
    }));
    const status = vi.fn(async () => ({
      ...remoteReadyStatus,
      attachment: { ...remoteReadyStatus.attachment,
        attachmentId: "attachment-history", sourceMessageId: "message-history" },
      sourceEligibility: "bound-active" as const,
      accessProjection: "authorized" as const,
    }));
    const attachmentBridge = { ...attachmentHarness().bridge, status };
    const root = document.createElement("main");
    const dispose = mountMessageAuthorityBridgeSurface(root, authority.bridge, "room-1", {
      createMessageId: () => "message-new", createTargetId: () => "target-new", attachmentBridge,
    });
    await vi.waitFor(() => expect(root.textContent).toContain("跨设备报告.pdf"));

    authority.publish({ type: "message.connection", roomId: "room-1",
      connection: { status: "repairing", watermark: 9 } });
    expect(root.textContent).toContain("跨设备报告.pdf");
    expect(root.querySelector("[data-action='preview-attachment']")).toBeNull();
    authority.publish({ type: "message.connection", roomId: "room-1", connection: {
      status: "offline", asOf: "2026-08-19T08:02:00.000Z",
    } });
    expect(root.textContent).toContain("跨设备报告.pdf");
    expect(root.querySelector("[data-action='download-attachment']")).toBeNull();
    root.querySelector<HTMLButtonElement>("[data-action='reconnect-message-authority']")?.click();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(root.querySelector("[data-action='preview-attachment']")).not.toBeNull());

    const recall = recalledEvent(10, "message-history");
    authority.publish({ type: "room.event", cursorBefore: 9, generation: 4,
      event: { ...recall, payload: { ...recall.payload, revisionCount: 1 } } });
    expect(root.textContent).toContain("消息已撤回");
    expect(root.textContent).not.toContain("跨设备报告.pdf");
    expect(root.querySelector("[data-attachment-id='attachment-history']")).toBeNull();
    dispose();
    authority.close();
  });
});
