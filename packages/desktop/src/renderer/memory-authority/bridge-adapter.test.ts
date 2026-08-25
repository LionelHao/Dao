import type {
  RoomMemoryContextDisputeAccepted,
  RoomMemoryPageFrame,
  RoomMemorySourceFrame,
  RoomMemorySourceView,
  RoomMemoryStatus,
  RoomMemoryVersionProjection,
} from "@native-im/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryAuthorityClientApplication,
  MemoryAuthorityClientPort,
  MemoryAuthorityEpochRequest,
  MemoryAuthorityEpochResponse,
} from "./client.js";
import { mountMemoryAuthorityBridgeSurface } from "./bridge-adapter.js";
import { createMemoryAuthorityController } from "./controller.js";

const at = "2026-08-19T08:00:00.000Z";
const status: RoomMemoryStatus = {
  roomId: "room-1", health: { state: "healthy", reason: "none", memoryWatermark: 1,
    corpusHead: 1, lag: 0, lastAttemptAt: at, retryable: false, recoveryRequired: false },
  recoveryGeneration: 2, updatedAt: at,
};
const source: RoomMemorySourceView = {
  roomId: "room-1", sourceKind: "attachment_extraction",
  sourceId: "attachment-extraction:attachment-1:1", sourceRevision: 1,
  corpusSeq: 1, occurredAt: at, eligibility: "eligible", availability: "readable",
  metadata: { speakerActorId: "human-1", speakerKind: "human", provenance: "report.pdf" },
  navigation: { kind: "attachment", attachmentId: "attachment-1" },
};
const projection: RoomMemoryVersionProjection = {
  projectionKind: "memory", roomId: "room-1", memoryRecordId: "memory-1", kind: "context",
  currentVersion: { roomId: "room-1", memoryRecordId: "memory-1",
    memoryVersionId: "memory-version-1", version: 1, kind: "context", state: "active",
    derivedText: "Review the attached migration report.", sourceRefs: [{
      sourceKind: "attachment_extraction", sourceId: "attachment-extraction:attachment-1:1",
      sourceRevision: 1, eligibility: "eligible", availability: "readable",
    }], createdAt: at, replacesMemoryVersionId: null },
  disputes: [], resolutions: [],
};

class Port implements MemoryAuthorityClientPort {
  listener: ((input: MemoryAuthorityClientApplication) => void) | undefined;
  calls: MemoryAuthorityEpochRequest[] = [];
  async request(input: MemoryAuthorityEpochRequest): Promise<MemoryAuthorityEpochResponse> {
    this.calls.push(structuredClone(input));
    const frame = input.frame;
    if (frame.type === "room.memory.query.v1") {
      const page: RoomMemoryPageFrame = { type: "room.memory.page.v1", requestId: frame.requestId,
        roomId: frame.roomId, items: [projection], nextCursor: null, status };
      return { accessEpoch: input.accessEpoch, frame: page };
    }
    if (frame.type === "room.memory.source.query.v1") {
      const result: RoomMemorySourceFrame = { type: "room.memory.source.v1", requestId: frame.requestId,
        roomId: frame.roomId, source };
      return { accessEpoch: input.accessEpoch, frame: result };
    }
    if (frame.type === "room.memory.context.dispute.v1") {
      const accepted: RoomMemoryContextDisputeAccepted = {
        type: "room.memory.context.dispute.accepted.v1", requestId: frame.requestId, roomId: frame.roomId,
        dispute: { disputeId: "dispute-1", roomId: frame.roomId,
          memoryRecordId: frame.memoryRecordId, memoryVersionId: "memory-version-1",
          operatorActorId: "human-1", reason: frame.reason, status: "open", createdAt: at },
        projection: { ...projection, currentVersion: { ...projection.currentVersion,
          memoryVersionId: "memory-version-2", version: 2, state: "disputed",
          derivedText: "ACK projection must await stable application.",
          replacesMemoryVersionId: "memory-version-1" } },
      };
      return { accessEpoch: input.accessEpoch, frame: accepted };
    }
    throw new Error("unexpected request");
  }
  subscribe(listener: (input: MemoryAuthorityClientApplication) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  close(): void {}
  publish(input: MemoryAuthorityClientApplication): void { this.listener?.(structuredClone(input)); }
}

afterEach(() => document.body.replaceChildren());

describe("Memory Authority production renderer bridge", () => {
  it("mounts the live panel, emits exact source/dispute intents, and never uses a static route", async () => {
    const port = new Port();
    let sequence = 0;
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-${++sequence}` });
    const root = document.createElement("aside");
    document.body.append(root);
    const navigate = vi.fn();
    const dispose = mountMemoryAuthorityBridgeSurface(root, controller, {
      roomId: "room-1", accessEpoch: 3, lifecycle: "active",
      viewer: { actorId: "human-1", currentHuman: true }, reducedMotion: false,
    }, { onNavigateSource: navigate });
    await vi.waitFor(() => expect(root.textContent).toContain("Review the attached migration report."));

    root.querySelector<HTMLButtonElement>("button[data-source-id]")?.click();
    expect(navigate).toHaveBeenCalledWith({
      roomId: "room-1", accessEpoch: 3,
      navigation: { kind: "attachment", attachmentId: "attachment-1" },
    });
    expect(JSON.stringify(navigate.mock.calls)).not.toMatch(/messageId|https?:|url/iu);

    root.querySelector<HTMLButtonElement>("[data-action='dispute']")?.click();
    const textarea = root.querySelector<HTMLTextAreaElement>("[data-memory-dialog] textarea")!;
    textarea.value = "The report is obsolete.";
    root.querySelector<HTMLButtonElement>("[data-action='submit-dispute']")?.click();
    await vi.waitFor(() => expect(port.calls.some((call) =>
      call.frame.type === "room.memory.context.dispute.v1" &&
      call.frame.reason === "The report is obsolete.")).toBe(true));
    await vi.waitFor(() => expect(controller.current("room-1")?.panel.operation.status).toBe("acknowledged"));
    expect(root.textContent).toContain("Review the attached migration report.");
    expect(root.textContent).not.toContain("ACK projection must await stable application.");
    dispose();
    controller.close();
  });

  it("preserves Escape focus return and bounds/de-duplicates polite announcements", async () => {
    const port = new Port();
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-1` });
    const root = document.createElement("aside");
    document.body.append(root);
    const dispose = mountMemoryAuthorityBridgeSurface(root, controller, {
      roomId: "room-1", accessEpoch: 3, lifecycle: "active",
      viewer: { actorId: "human-1", currentHuman: true }, reducedMotion: true,
    }, { onNavigateSource: vi.fn() });
    await vi.waitFor(() => expect(root.querySelector("[data-action='dispute']")).not.toBeNull());
    const trigger = root.querySelector<HTMLButtonElement>("[data-action='dispute']")!;
    trigger.focus();
    trigger.click();
    const dialog = root.querySelector<HTMLElement>("[data-memory-dialog]")!;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(trigger);

    port.publish({ type: "room.memory.connection", roomId: "room-1", accessEpoch: 3,
      connection: { status: "offline" } });
    const first = root.querySelector("[data-memory-live]")?.textContent ?? "";
    expect(first).toContain("离线");
    expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(256);
    expect(root.querySelector("[data-memory-live]")?.getAttribute("aria-live")).toBe("polite");
    port.publish({ type: "room.memory.connection", roomId: "room-1", accessEpoch: 3,
      connection: { status: "offline" } });
    expect(root.querySelector("[data-memory-live]")?.textContent).toBe("");
    expect(root.querySelector("[data-memory-sources]")?.getAttribute("aria-live")).toBe("off");
    dispose();
    controller.close();
  });
});
