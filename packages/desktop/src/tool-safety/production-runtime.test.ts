import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DesktopAuthorityCache } from "../governance/authority-cache.js";
import type { MessageAuthorityWireTransport } from "../message-authority/websocket-authority.js";
import { MessageAuthorityTransportError } from "../message-authority/websocket-authority.js";
import { mountToolSafetyBridgeSurface } from "../renderer/tool-safety/bridge-adapter.js";
import { createToolSafetyBridge } from "./preload-bridge.js";
import { registerToolSafetyIpc } from "./ipc.js";
import { createDesktopToolSafetyRuntime } from "./production-runtime.js";

const preview = JSON.stringify({ schemaVersion: "tool-safe-preview.v1", target: "notes/release.txt",
  summary: "Create or replace a sandbox file (12 UTF-8 bytes; expected abc123…)",
  impact: "Writes one configured sandbox-relative file after an exact hash fence",
  reversibility: "compensatable" });
const call = { kind: "tool-call", value: { toolCallId: "call-1", toolId: "sandbox-file.write",
  safePreview: preview, state: "prepared", version: 1, sourceRef: "message-1" } } as const;
const pending = { kind: "tool-confirmation", value: { confirmationId: "confirmation-1",
  toolCallId: "call-1", toolId: "sandbox-file.write", state: "pending", safePreview: preview,
  reasonCode: null, expiresAt: "2026-08-30T08:10:00.000Z", version: 1,
  principalActorId: "human-1", namedHumanDisplayRef: "Human A", sourceRef: "message-1" } } as const;

describe("Tool Safety production bridge", () => {
  it("is registered and explicitly started by the production main process", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../main.ts"), "utf8");
    expect(source).toContain("createDesktopToolSafetyRuntime");
    expect(source).toContain("toolSafety.start()");
    expect(source).toContain("registerToolSafetyIpc");
    expect(source).toContain("toolSafetyMethods");
  });
  it("starts in main authority, crosses IPC, and lets repair/stable projection drive live J-05 DOM", async () => {
    let records: readonly unknown[] = [call, pending];
    const cacheListeners = new Set<(roomId: string, records: readonly never[] | undefined) => void>();
    const cache = {
      roomRepairRecords: (roomId: string) => roomId === "room-1" ? records : undefined,
      governanceProjection: (roomId: string) => roomId === "room-1" ? { roomId, lifecycle: "active" } : undefined,
      subscribeRoomRecords(listener: (roomId: string, records: readonly never[] | undefined) => void) {
        cacheListeners.add(listener); return () => cacheListeners.delete(listener);
      },
      roomIds: () => ["room-1"], clear: vi.fn(), clearRoom: vi.fn(),
    } as unknown as DesktopAuthorityCache;
    const commands: unknown[] = [];
    const transport = {
      async toolSafetyCommand(command: { type: string; requestId: string }) {
        commands.push(structuredClone(command));
        return { type: "tool.safety.command.ack" as const, requestId: command.requestId,
          operation: command.type, objectId: "confirmation-1", version: 2, replayed: false };
      },
      onTerminalRevoked: () => () => undefined,
      onRoomAccessChanged: () => () => undefined,
      onConnectionFailure: () => () => undefined,
    } as unknown as MessageAuthorityWireTransport;
    const repairRoom = vi.fn(async () => {
      records = [call, { ...pending, value: { ...pending.value, state: "confirmed" as const, version: 2 } }];
      for (const listener of cacheListeners) listener("room-1", records as readonly never[]);
    });
    const runtime = createDesktopToolSafetyRuntime({
      session: () => ({ actorId: "human-1", sessionId: "session-1", accessToken: "authority-token" }) as never,
      transport, authorityCache: cache, repairRoom, createRequestId: () => "tool-request-1",
    });
    const observedStatuses: string[] = [];
    runtime.subscribe(({ state }) => observedStatuses.push(state.operation.status));
    await expect(runtime.getSurface({ roomId: "room-1" })).rejects.toThrow("not started");
    runtime.start();

    const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
    const rendererListeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
    const webContents = { mainFrame: {}, isDestroyed: () => false,
      send(channel: string, value: unknown) {
        for (const listener of rendererListeners.get(channel) ?? []) listener({}, structuredClone(value));
      } };
    const disposeIpc = registerToolSafetyIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as never),
        removeHandler: (channel) => { handlers.delete(channel); } },
      webContents,
      runtime,
    });
    const bridge = createToolSafetyBridge({
      async invoke(channel, value) {
        const handler = handlers.get(channel)!;
        return await handler({ sender: webContents, senderFrame: webContents.mainFrame }, value);
      },
      on(channel, listener) {
        const listeners = rendererListeners.get(channel) ?? new Set(); listeners.add(listener);
        rendererListeners.set(channel, listeners);
      },
      removeListener(channel, listener) { rendererListeners.get(channel)?.delete(listener); },
    });
    const root = document.createElement("aside"); document.body.append(root);
    const disposeSurface = mountToolSafetyBridgeSurface(root, bridge, "room-1", {
      openSource: vi.fn(), newInvocation: vi.fn(), reauthenticate: vi.fn(),
    });
    await vi.waitFor(() => expect(root.textContent).toContain("等待精确 Human 确认"));
    root.querySelector<HTMLButtonElement>("[data-tool-safety-action='confirm']")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Human 决定已记录 · 尚未执行"));
    expect(observedStatuses).toContain("acknowledged");
    expect(observedStatuses.at(-1)).toBe("idle");
    await vi.waitFor(() => expect(document.activeElement).toBe(
      root.querySelector("[data-tool-safety-state-heading]")));
    expect(commands).toEqual([{
      type: "tool.confirmation.decide", requestId: "tool-request-1", confirmationId: "confirmation-1",
      expectedVersion: 1, decision: "confirm",
    }]);
    expect(repairRoom).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain("工具结果已知成功");

    records = [...records, { kind: "tool-dispatch", value: { dispatchId: "dispatch-1", toolCallId: "call-1",
      state: "outcome_unknown", reasonCode: "adapter_timeout", version: 3 } }];
    for (const listener of cacheListeners) listener("room-1", records as readonly never[]);
    await vi.waitFor(() => expect(root.textContent).toContain("OUTCOME UNKNOWN · 需要 Human 审查"));
    expect(root.querySelector("[data-tool-safety-evidence]")).not.toBeNull();
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    for (const listener of cacheListeners) listener("room-1", records as readonly never[]);
    expect(document.activeElement).toBe(outside);

    disposeSurface(); disposeIpc(); runtime.close(); root.remove(); outside.remove();
  });

  it("performs zero transport writes offline and preserves the last complete cards when repair fails", async () => {
    let failure: (() => void) | undefined;
    const command = vi.fn();
    const cache = { roomRepairRecords: () => [call, pending],
      governanceProjection: () => ({ lifecycle: "active" }), roomIds: () => ["room-1"],
      subscribeRoomRecords: () => () => undefined, clear: vi.fn(), clearRoom: vi.fn() } as unknown as DesktopAuthorityCache;
    const transport = { toolSafetyCommand: command, onTerminalRevoked: () => () => undefined,
      onRoomAccessChanged: () => () => undefined,
      onConnectionFailure(listener: () => void) { failure = listener; return () => undefined; } } as unknown as MessageAuthorityWireTransport;
    const runtime = createDesktopToolSafetyRuntime({ session: () => ({ actorId: "human-1" }) as never,
      transport, authorityCache: cache, repairRoom: async () => { throw new Error("repair failed"); },
      createRequestId: () => "request-offline" });
    runtime.start(); await runtime.getSurface({ roomId: "room-1" }); failure?.();
    const offline = await runtime.submit({ roomId: "room-1", command: { type: "tool.confirmation.decide",
      confirmationId: "confirmation-1", expectedVersion: 1, decision: "confirm" } });
    expect(command).not.toHaveBeenCalled();
    expect(offline.connection.status).toBe("offline");
    const failed = await runtime.repair({ roomId: "room-1" });
    expect(failed.connection).toEqual({ status: "repair-failed", errorCode: "repair_unavailable" });
    expect(failed.cards).toHaveLength(1);
    expect(failed.cards[0]?.safeTarget).toBe("notes/release.txt");
    runtime.close();
  });

  it("maps principal revoke, parameter changes, and duplicate 409 without treating permission_denied as Room revoke", async () => {
    let records: readonly unknown[] = [call, pending];
    let mode: "principal" | "params" | "duplicate" = "principal";
    const clearRoom = vi.fn();
    const cache = { roomRepairRecords: () => records,
      governanceProjection: () => ({ lifecycle: "active" }), roomIds: () => ["room-1"],
      subscribeRoomRecords: () => () => undefined, clear: vi.fn(), clearRoom } as unknown as DesktopAuthorityCache;
    const transport = { async toolSafetyCommand() {
      const error = mode === "principal" ? { status: 403 as const, code: "permission_denied" }
        : { status: 409 as const, code: mode === "params" ? "tool_parameters_changed" : "tool_already_terminal" };
      throw new MessageAuthorityTransportError("protocol_error", undefined, undefined, undefined, undefined, error);
    }, onTerminalRevoked: () => () => undefined, onRoomAccessChanged: () => () => undefined,
    onConnectionFailure: () => () => undefined } as unknown as MessageAuthorityWireTransport;
    const repairRoom = vi.fn(async () => {
      if (mode === "principal") records = [call, { ...pending, value: { ...pending.value,
        state: "rejected" as const, reasonCode: "principal_revoked", version: 2 } }];
      if (mode === "params") records = [call, { ...pending, value: { ...pending.value,
        state: "rejected" as const, reasonCode: "tool_parameters_changed", version: 2 } }];
    });
    const runtime = createDesktopToolSafetyRuntime({ session: () => ({ actorId: "human-1" }) as never,
      transport, authorityCache: cache, repairRoom, createRequestId: () => `request-${mode}` });
    runtime.start();
    const submit = () => runtime.submit({ roomId: "room-1", command: { type: "tool.confirmation.decide" as const,
      confirmationId: "confirmation-1", expectedVersion: 1, decision: "confirm" as const } });
    expect((await submit()).cards[0]?.state).toBe("principal-revoked");
    expect(clearRoom).not.toHaveBeenCalled();
    mode = "params"; records = [call, pending];
    expect((await submit()).cards[0]?.state).toBe("params-changed");
    mode = "duplicate"; records = [call, pending];
    expect((await submit()).cards[0]?.state).toBe("duplicate");
    records = [call, { ...pending, value: { ...pending.value, state: "confirmed" as const, version: 2 } },
      { kind: "tool-dispatch", value: { dispatchId: "dispatch-1", toolCallId: "call-1",
        state: "claimed", reasonCode: null, version: 2 } }];
    expect((await runtime.getSurface({ roomId: "room-1" })).cards[0]?.state).toBe("dispatched");
    expect(clearRoom).not.toHaveBeenCalled();
    runtime.close();
  });

  it("preserves archived facts read-only, then purges authority on terminal and Room access loss", async () => {
    let terminal: (() => void) | undefined;
    let access: ((roomId: string, change: "removed" | "archived" | "restored") => void) | undefined;
    const clear = vi.fn();
    const clearRoom = vi.fn();
    const cache = { roomRepairRecords: () => [call, pending],
      governanceProjection: () => ({ lifecycle: "active" }), roomIds: () => ["room-1"],
      subscribeRoomRecords: () => () => undefined, clear, clearRoom } as unknown as DesktopAuthorityCache;
    const transport = { toolSafetyCommand: vi.fn(),
      onTerminalRevoked(listener: () => void) { terminal = listener; return () => undefined; },
      onRoomAccessChanged(listener: typeof access) { access = listener; return () => undefined; },
      onConnectionFailure: () => () => undefined } as unknown as MessageAuthorityWireTransport;
    const runtime = createDesktopToolSafetyRuntime({ session: () => ({ actorId: "human-1" }) as never,
      transport, authorityCache: cache, repairRoom: vi.fn(), createRequestId: () => "request-revoked" });
    runtime.start();
    expect((await runtime.getSurface({ roomId: "room-1" })).cards).toHaveLength(1);
    access?.("room-1", "archived");
    const archived = await runtime.getSurface({ roomId: "room-1" });
    expect(archived.connection.status).toBe("archived");
    expect(archived.cards).toHaveLength(1);
    expect(transport.toolSafetyCommand).not.toHaveBeenCalled();
    access?.("room-1", "removed");
    expect((await runtime.getSurface({ roomId: "room-1" })).connection.status).toBe("revoked");
    expect(clearRoom).toHaveBeenCalledWith("room-1");
    terminal?.();
    expect(clear).toHaveBeenCalledOnce();
    expect((await runtime.getSurface({ roomId: "room-1" })).cards).toEqual([]);
    runtime.close();
  });

  it("derives compensation states from current confirmation, grant and dispatch facts", async () => {
    const compensationCall = { ...call, value: { ...call.value, toolCallId: "call-compensation" } } as const;
    const confirmation = { ...pending, value: { ...pending.value, confirmationId: "confirmation-compensation",
      toolCallId: "call-compensation", state: "confirmed" as const, version: 2 } };
    const lineage = { kind: "tool-compensation", value: { lineageId: "lineage-1",
      originalDispatchId: "dispatch-original", compensationInvocationId: "invocation-2",
      compensationExecutionId: "execution-2", compensationToolCallId: "call-compensation",
      state: "pending", version: 1 } } as const;
    let records: readonly unknown[] = [compensationCall, confirmation, lineage];
    const cache = { roomRepairRecords: () => records,
      governanceProjection: () => ({ lifecycle: "active" }), roomIds: () => ["room-1"],
      subscribeRoomRecords: () => () => undefined, clear: vi.fn(), clearRoom: vi.fn() } as unknown as DesktopAuthorityCache;
    const transport = { toolSafetyCommand: vi.fn(), onTerminalRevoked: () => () => undefined,
      onRoomAccessChanged: () => () => undefined, onConnectionFailure: () => () => undefined } as unknown as MessageAuthorityWireTransport;
    const runtime = createDesktopToolSafetyRuntime({ session: () => ({ actorId: "human-1" }) as never,
      transport, authorityCache: cache, repairRoom: vi.fn(), createRequestId: () => "request-compensation" });
    runtime.start();
    expect((await runtime.getSurface({ roomId: "room-1" })).cards[0]?.state).toBe("compensation-confirmed");
    records = [...records, { kind: "tool-dispatch", value: { dispatchId: "dispatch-compensation",
      toolCallId: "call-compensation", state: "claimed", reasonCode: null, version: 2 } }];
    expect((await runtime.getSurface({ roomId: "room-1" })).cards[0]?.state).toBe("compensation-dispatched");
    records = records.map((entry) => (entry as { kind?: string }).kind === "tool-dispatch"
      ? { kind: "tool-dispatch", value: { dispatchId: "dispatch-compensation",
        toolCallId: "call-compensation", state: "outcome_unknown", reasonCode: "adapter_ambiguous", version: 3 } }
      : entry);
    records = [...records, { kind: "tool-review", value: { reviewId: "review-compensation",
      dispatchId: "dispatch-compensation", resolution: "accepted_risk", evidenceSummary: "checked",
      namedHumanDisplayRef: "Human A", compensationToolCallId: null, version: 4 } }];
    expect((await runtime.getSurface({ roomId: "room-1" })).cards[0]?.state).toBe("reviewed");
    runtime.close();
  });

  it("projects compensation proposal, exact grant expiry, and the designated unknown reviewer", async () => {
    const grant = { kind: "tool-grant", value: { grantId: "grant-1", toolCallId: "call-1",
      state: "expired", reasonCode: "grant_expired", expiresAt: "2026-08-30T08:01:00.000Z",
      version: 3 } } as const;
    const unknown = { kind: "tool-dispatch", value: { dispatchId: "dispatch-1", toolCallId: "call-1",
      state: "outcome_unknown", reasonCode: "adapter_ambiguous", version: 4 } } as const;
    const lineage = { kind: "tool-compensation", value: { lineageId: "lineage-1",
      originalDispatchId: "dispatch-1", compensationInvocationId: "invocation-2",
      compensationExecutionId: "execution-2", compensationToolCallId: "call-compensation",
      state: "pending", version: 1 } } as const;
    let records: readonly unknown[] = [call, pending, grant];
    let viewer = "human-1";
    const cache = { roomRepairRecords: () => records,
      governanceProjection: () => ({ lifecycle: "active", ownerActorId: "human-owner" }),
      roomIds: () => ["room-1"], subscribeRoomRecords: () => () => undefined,
      clear: vi.fn(), clearRoom: vi.fn() } as unknown as DesktopAuthorityCache;
    const runtime = createDesktopToolSafetyRuntime({ session: () => ({ actorId: viewer }) as never,
      transport: { toolSafetyCommand: vi.fn(), onTerminalRevoked: () => () => undefined,
        onRoomAccessChanged: () => () => undefined,
        onConnectionFailure: () => () => undefined } as unknown as MessageAuthorityWireTransport,
      authorityCache: cache, repairRoom: vi.fn(), createRequestId: () => "request-projection" });
    runtime.start();
    const expired = (await runtime.getSurface({ roomId: "room-1" })).cards[0]!;
    expect(expired).toMatchObject({ state: "expired", reasonCode: "grant_expired",
      expiresAt: "2026-08-30T08:01:00.000Z", canDecide: true });
    records = [call, unknown];
    expect((await runtime.getSurface({ roomId: "room-1" })).cards[0]?.canDecide).toBe(false);
    viewer = "human-owner";
    expect((await runtime.getSurface({ roomId: "room-1" })).cards[0]?.canDecide).toBe(true);
    records = [call, pending, unknown, lineage];
    expect((await runtime.getSurface({ roomId: "room-1" })).cards[0]?.state)
      .toBe("compensation-proposed");
    runtime.close();
  });
});
