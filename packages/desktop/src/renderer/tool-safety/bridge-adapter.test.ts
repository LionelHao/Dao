import { describe, expect, it, vi } from "vitest";
import type { ToolSafetyBridge, ToolSafetyRemoteState, ToolSafetyStateEnvelope } from "../../tool-safety/contracts.js";
import { mountToolSafetyBridgeSurface } from "./bridge-adapter.js";

const ready = (statusCode?: 409 | 410): ToolSafetyRemoteState => ({
  roomId: "room-1", connection: { status: "online" },
  cards: [{ toolCallId: "call-1", confirmationId: "confirmation-1", version: 1,
    state: statusCode === 409 ? "duplicate" : statusCode === 410 ? "expired" : "pending",
    toolId: "sandbox-file.write", safeTarget: "notes/release.txt", parameterSummary: "12 bytes",
    impact: "write one file", reversibility: "compensatable", expiresAt: "2026-08-30T08:10:00.000Z",
    sourceRef: "message-1" }],
  operation: statusCode === undefined ? { status: "idle" } : { status: "error",
    requestId: `request-${statusCode}`, action: "confirm", statusCode,
    code: statusCode === 409 ? "tool_already_terminal" : "tool_confirmation_expired" },
});

describe("Tool Safety renderer bridge", () => {
  it.each([409, 410] as const)("focuses the %s recovery action once and never refocuses a duplicate event", async (statusCode) => {
    const listeners = new Set<(state: ToolSafetyStateEnvelope) => void>();
    const bridge = { getSurface: async () => ready(), repair: async () => ready(statusCode),
      async submit() {
        const state = ready(statusCode); for (const listener of listeners) listener({ roomId: "room-1", state });
        return state;
      },
      onStateChanged(listener: (state: ToolSafetyStateEnvelope) => void) {
        listeners.add(listener); return () => listeners.delete(listener);
      } } satisfies ToolSafetyBridge;
    const root = document.createElement("aside"); document.body.append(root);
    const dispose = mountToolSafetyBridgeSurface(root, bridge, "room-1", {
      openSource: vi.fn(), newInvocation: vi.fn(), reauthenticate: vi.fn(),
    });
    await vi.waitFor(() => expect(root.textContent).toContain("等待精确 Human 确认"));
    root.querySelector<HTMLButtonElement>("[data-tool-safety-action='confirm']")!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(
      root.querySelector("[data-recovery-action]")));
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    const duplicate = ready(statusCode);
    for (const listener of listeners) listener({ roomId: "room-1", state: duplicate });
    expect(document.activeElement).toBe(outside);
    dispose(); root.remove(); outside.remove();
  });

  it("retains the complete authority card while repair is unavailable", async () => {
    const failed: ToolSafetyRemoteState = { ...ready(),
      connection: { status: "repair-failed", errorCode: "repair_unavailable" } };
    const bridge = { getSurface: async () => failed, repair: async () => failed,
      submit: async () => failed, onStateChanged: () => () => undefined } satisfies ToolSafetyBridge;
    const root = document.createElement("aside"); document.body.append(root);
    const dispose = mountToolSafetyBridgeSurface(root, bridge, "room-1", {
      openSource: vi.fn(), newInvocation: vi.fn(), reauthenticate: vi.fn(),
    });
    await vi.waitFor(() => expect(root.textContent).toContain("notes/release.txt"));
    expect(root.textContent).toContain("repair 失败");
    expect(root.querySelector<HTMLButtonElement>("[data-tool-safety-action='confirm']")?.disabled).toBe(true);
    dispose(); root.remove();
  });
});
