import { describe, expect, it, vi } from "vitest";
import type { ProjectLoopWireRequest, ProjectLoopWireResponse } from "./contracts.js";
import { createDesktopProjectLoopRuntime } from "./production-runtime.js";
import { projectSnapshot } from "./test-fixture.js";
import type { RoomSubscriptionObserver } from "../sync/client-sync-replica.js";

describe("FT-09 Desktop Project Loop production runtime", () => {
  it("sends exact request intents, exposes submitting/ACK, and refreshes instead of applying ACK optimistically", async () => {
    const calls: ProjectLoopWireRequest[] = [];
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const projectRequest = vi.fn(async (frame: ProjectLoopWireRequest): Promise<ProjectLoopWireResponse> => {
      calls.push(frame);
      if (frame.type === "project.snapshot.read") return { type: "project.snapshot", requestId: frame.requestId,
        snapshot: projectSnapshot(), events: [], nextEventSeq: 7 };
      await mutationGate;
      return { type: "project.mutation.ack", requestId: frame.requestId, roomId: frame.roomId,
        projectId: frame.projectId, acceptedRevision: 8, eventIds: ["event-8"], replayed: false };
    });
    const transport = {
      projectRequest,
      async subscribeRoom(_roomId: string, cursor: { version: 1; roomId: string; afterSeq: number }) {
        return { cursor, close: vi.fn() };
      },
      onTerminalRevoked: () => () => {}, onRoomAccessChanged: () => () => {},
      onConnectionFailure: () => () => {}, close: vi.fn(),
    };
    let sequence = 0;
    const runtime = createDesktopProjectLoopRuntime({ session: () => ({ actorId: "human-2", sessionId: "session-1",
      accessToken: "token", expiresAt: "2026-08-26T00:00:00.000Z" }), transport,
    createRequestIdentity: () => ({ requestId: `request-${++sequence}`, idempotencyKey: `idem-${sequence}` }) });
    await runtime.getSurface({ roomId: "room-1" });
    const states: unknown[] = []; runtime.subscribe((input) => states.push(input.state));
    const submitted = runtime.submit({ roomId: "room-1", intent: { kind: "request.transition",
      intentId: "accept-request-1", factId: "request-1", expectedRevision: 3, action: "accept" } });
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({ status: "ready", snapshot: { watermark: 7 },
      operation: { status: "submitting" } });
    releaseMutation?.();
    await submitted;
    expect(calls[1]).toMatchObject({ type: "project.request.transition", roomId: "room-1",
      projectId: "room-1", factId: "request-1", expectedRevision: 3, action: "accept" });
    expect(states.some((state) => (state as { operation?: { status?: string } }).operation?.status === "acknowledged"))
      .toBe(true);
    expect(projectRequest).toHaveBeenCalledTimes(3);
    runtime.close();
  });

  it("locks and clears on terminal revocation while retaining a complete cache on offline failure", async () => {
    let revoked: (() => void) | undefined; let failed: (() => void) | undefined;
    const transport = { async projectRequest(frame: ProjectLoopWireRequest): Promise<ProjectLoopWireResponse> {
      if (frame.type !== "project.snapshot.read") throw new Error("unexpected mutation");
      return { type: "project.snapshot", requestId: frame.requestId, snapshot: projectSnapshot(), events: [], nextEventSeq: 7 };
    }, async subscribeRoom(_roomId: string, cursor: { version: 1; roomId: string; afterSeq: number }) {
      return { cursor, close() {} };
    }, onTerminalRevoked(listener: () => void) { revoked = listener; return () => {}; },
    onRoomAccessChanged: () => () => {}, onConnectionFailure(listener: () => void) { failed = listener; return () => {}; },
    close() {} };
    const runtime = createDesktopProjectLoopRuntime({ session: () => ({ actorId: "human-1", sessionId: "session-1",
      accessToken: "token", expiresAt: "2026-08-26T00:00:00.000Z" }), transport,
    createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }),
    now: () => "2026-08-25T05:00:00.000Z" });
    const states: unknown[] = []; runtime.subscribe((input) => states.push(input.state));
    await runtime.getSurface({ roomId: "room-1" }); failed?.();
    expect(states.at(-1)).toMatchObject({ status: "ready",
      connection: { status: "offline" }, snapshot: { watermark: 7 } });
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({ status: "ready",
      connection: { status: "online" }, snapshot: { watermark: 7 } });
    revoked?.();
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({ status: "locked",
      error: { status: 401 } });
    runtime.close();
  });

  it("ignores duplicate stable events, repairs gaps, and fails closed above the 512-event bound", async () => {
    let observer: RoomSubscriptionObserver | undefined; let queryCount = 0;
    const transport = { async projectRequest(frame: ProjectLoopWireRequest): Promise<ProjectLoopWireResponse> {
      if (frame.type !== "project.snapshot.read") throw new Error("unexpected mutation"); queryCount += 1;
      return { type: "project.snapshot", requestId: frame.requestId,
        snapshot: projectSnapshot({ watermark: queryCount === 1 ? 7 : 9 }), events: [], nextEventSeq: 9 };
    }, async subscribeRoom(_roomId: string, cursor: { version: 1; roomId: string; afterSeq: number }, next: RoomSubscriptionObserver) {
      observer = next; return { cursor, close() {} };
    }, onTerminalRevoked: () => () => {}, onRoomAccessChanged: () => () => {},
    onConnectionFailure: () => () => {}, close() {} };
    const runtime = createDesktopProjectLoopRuntime({ session: () => ({ actorId: "human-1", sessionId: "session-1",
      accessToken: "token", expiresAt: "2026-08-26T00:00:00.000Z" }), transport,
    createRequestIdentity: () => ({ requestId: `request-${queryCount + 1}`, idempotencyKey: "idem-1" }) });
    const states: unknown[] = []; runtime.subscribe((input) => states.push(input.state));
    await runtime.getSurface({ roomId: "room-1" }); await Promise.resolve();
    const request = projectSnapshot().requests[0]!;
    const event = { eventId: "event-8", streamKind: "room" as const, streamId: "room-1", streamSeq: 8,
      roomId: "room-1", projectId: "room-1", actorId: "human-2",
      occurredAt: "2026-08-25T03:03:04.005Z", type: "project.request.changed" as const, payload: request };
    await observer?.events([{ ...event, streamSeq: 7, eventId: "event-7" }],
      { version: 1, roomId: "room-1", afterSeq: 7 });
    expect(queryCount).toBe(1);
    await observer?.events([{ ...event, streamSeq: 9, eventId: "event-9" }],
      { version: 1, roomId: "room-1", afterSeq: 9 });
    expect(queryCount).toBe(2);
    await observer?.events(Array.from({ length: 513 }, (_, index) => ({ ...event,
      streamSeq: index + 10, eventId: `event-${index + 10}` })),
    { version: 1, roomId: "room-1", afterSeq: 522 });
    expect(states.at(-1)).toMatchObject({ status: "ready",
      connection: { status: "repair_failed", code: "project_event_buffer_exceeded" } });
    runtime.close();
  });
});
