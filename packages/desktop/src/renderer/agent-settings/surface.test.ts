import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSettingsSnapshot, RoomAgentAssignmentProjection } from "../../agent-profile-routing/contracts.js";
import {
  createAgentSettingsInitialState,
  createAgentSettingsViewModel,
  type AgentSettingsMutationIntent,
} from "./view-model.js";
import { renderAgentSettingsSurface } from "./surface.js";

function assignment(overrides: Partial<RoomAgentAssignmentProjection> = {}): RoomAgentAssignmentProjection {
  return {
    recordVersion: "room-agent-assignment.v1", assignmentId: "assignment-research", roomId: "room-dao",
    profileId: "profile-research", actorId: "agent-research", displayName: "检索员",
    globalResponsibility: "跨 Room 的资料检索与来源核验", roomResponsibility: "核对迁移资料与引用",
    participation: "on-mention", availability: "ready", paused: false,
    capabilityCeiling: ["room.conversation.read", "room.memory.read"], capabilitySubset: ["room.memory.read"],
    effectiveCapabilities: ["room.memory.read"], toolCeiling: ["repository.git-status"],
    toolSubset: ["repository.git-status"], effectiveTools: ["repository.git-status"], profileRevision: 4,
    assignmentRevision: 8, accessRevision: 6, ...overrides,
  };
}

function snapshot(overrides: Partial<AgentSettingsSnapshot> = {}): AgentSettingsSnapshot {
  return {
    recordVersion: "agent-settings.snapshot.v1", cursor: 31,
    viewer: { actorId: "human-owner", tenantAdministrator: true, roomRole: "owner" },
    provider: { providerId: "openai", modelId: "gpt-5", credentialStatus: "configured", retentionDisabled: true, selectionPolicy: "server-managed-single" },
    profileCatalog: { status: "available", revision: 4, profiles: [{
      recordVersion: "agent-profile.v1", profileId: "profile-research", actorId: "agent-research",
      displayName: "检索员", globalResponsibility: "跨 Room 的资料检索与来源核验", status: "enabled",
      capabilityCeiling: ["room.conversation.read", "room.memory.read"], toolCeiling: ["repository.git-status"],
      revision: 4, createdAt: "2026-08-20T08:00:00.000Z", updatedAt: "2026-08-24T08:00:00.000Z",
    }] },
    room: { status: "available", roomId: "room-dao", roomName: "Dao 交付", lifecycle: "active", roomRevision: 12, assignments: [assignment()] },
    ...overrides,
  };
}

afterEach(() => document.body.replaceChildren());

function ready(overrides: Record<string, unknown> = {}) {
  return createAgentSettingsViewModel({
    ...createAgentSettingsInitialState(),
    query: { status: "ready" },
    snapshot: snapshot(overrides),
  });
}

describe("FT-07 J-01/J-03/J-05 Agent Settings surface", () => {
  it("renders Human invitation, Global Profile and Room Assignment as explicit separate authority paths", () => {
    const root = document.createElement("main");
    renderAgentSettingsSurface(root, ready(), { onIntent: vi.fn(), onRecover: vi.fn(), onClose: vi.fn() });
    expect(root.querySelector("[data-settings-section='human-invitation']")?.textContent).toContain("Human invitation");
    expect(root.querySelector("[data-settings-section='global-profiles']")?.textContent).toContain("Tenant Administrator");
    expect(root.querySelector("[data-settings-section='room-assignments']")?.textContent).toContain("Room owner/admin");
    expect(root.textContent).toContain("agent-research");
    expect(root.textContent).toContain("on-mention");
    expect(root.textContent).toContain("ready");
    expect(root.querySelector("select[name='availability']")).toBeNull();
    expect(root.querySelector("input[name='availability']")).toBeNull();
    expect(root.textContent).not.toContain("silent");
  });

  it("discloses one server-managed Provider/model and has no BYOK, secret or selector", () => {
    const root = document.createElement("main");
    renderAgentSettingsSurface(root, ready(), { onIntent: vi.fn(), onRecover: vi.fn(), onClose: vi.fn() });
    const disclosure = root.querySelector("[data-provider-disclosure]");
    expect(disclosure?.textContent).toContain("openai");
    expect(disclosure?.textContent).toContain("gpt-5");
    expect(disclosure?.textContent).toContain("单 Provider / 单模型");
    expect(root.querySelector("select[name='providerId']")).toBeNull();
    expect(root.querySelector("input[name*='key' i]")).toBeNull();
    expect(root.textContent).not.toContain("BYOK");
  });

  it("emits closed mutation intent but never changes visible stable facts synchronously", () => {
    const root = document.createElement("main");
    const intents: AgentSettingsMutationIntent[] = [];
    renderAgentSettingsSurface(root, ready(), {
      onIntent: (intent) => intents.push(intent), onRecover: vi.fn(), onClose: vi.fn(),
    });
    const pause = root.querySelector<HTMLButtonElement>("[data-action='assignment.pause']");
    pause?.click();
    expect(intents).toEqual([{
      command: "assignment.pause",
      roomId: "room-dao",
      assignmentId: "assignment-research",
      expectedRoomRevision: 12,
      expectedAssignmentRevision: 8,
    }]);
    expect(root.querySelector("[data-availability='ready']")).not.toBeNull();
    expect(root.querySelector("[data-availability='paused']")).toBeNull();
  });

  it("renders pending ACK and every closed error with a single restrained announcement and focused recovery", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const state = {
      ...createAgentSettingsInitialState(),
      query: { status: "ready" } as const,
      snapshot: snapshot(),
      operation: {
        status: "failed" as const,
        requestId: "request-1",
        command: "assignment.update" as const,
        error: { status: 409 as const, code: "assignment_revision_conflict" as const },
      },
    };
    renderAgentSettingsSurface(root, createAgentSettingsViewModel(state), {
      onIntent: vi.fn(), onRecover: vi.fn(), onClose: vi.fn(),
    });
    const live = root.querySelectorAll("[role='status'][aria-live='polite']");
    expect(live).toHaveLength(1);
    const error = root.querySelector<HTMLElement>("[data-agent-settings-error]");
    expect(error?.textContent).toContain("409");
    expect(error?.textContent).toContain("assignment_revision_conflict");
    expect(error?.textContent).toContain("载入最新版本");
    expect(document.activeElement).toBe(error);
  });

  it("locks mutations for offline/repair/revoked while keeping only the authorized complete cache", () => {
    const root = document.createElement("main");
    const offline = createAgentSettingsViewModel({
      ...createAgentSettingsInitialState(), query: { status: "ready" }, snapshot: snapshot(),
      connection: { status: "offline", asOf: "2026-08-24T08:00:00.000Z", leaseExpiresAt: "2026-08-24T09:00:00.000Z" },
    });
    renderAgentSettingsSurface(root, offline, { onIntent: vi.fn(), onRecover: vi.fn(), onClose: vi.fn() });
    expect(root.querySelector("[data-connection-banner]")?.textContent).toContain("离线只读");
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>("[data-agent-mutation]")).every((button) => button.disabled)).toBe(true);

    const revoked = createAgentSettingsViewModel({
      ...createAgentSettingsInitialState(),
      query: { status: "ready" },
      connection: { status: "revoked", scope: "room", purgeCompleted: true },
    });
    renderAgentSettingsSurface(root, revoked, { onIntent: vi.fn(), onRecover: vi.fn(), onClose: vi.fn() });
    expect(root.textContent).not.toContain("Dao 交付");
    expect(root.textContent).not.toContain("检索员");
    expect(root.querySelector("[role='alert']")?.textContent).toContain("缓存已清除");
  });
});

describe("FT-16 keyboard, focus, 840×560, 200% and reduced motion", () => {
  it("uses native keyboard controls, a close return seam and non-colour status cues", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const close = vi.fn();
    renderAgentSettingsSurface(root, ready(), { onIntent: vi.fn(), onRecover: vi.fn(), onClose: close });
    expect(Array.from(root.querySelectorAll("[data-agent-mutation]")).every((value) => value.tagName === "BUTTON")).toBe(true);
    expect(root.querySelector("[data-availability='ready']")?.textContent).toMatch(/●.*ready/u);
    root.querySelector<HTMLButtonElement>("[data-action='close-settings']")?.click();
    expect(close).toHaveBeenCalledOnce();
    root.querySelector<HTMLElement>(".dao-agent-settings")?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    }));
    expect(close).toHaveBeenCalledTimes(2);
    expect(root.querySelector("[role='dialog'][aria-modal='true']")).not.toBeNull();
  });

  it("defines bounded reflow, visible focus and reduced motion", () => {
    const css = readFileSync(resolve(import.meta.dirname, "agent-settings.css"), "utf8");
    expect(css).toContain("max-inline-size: 100%");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/@media\s*\(max-width:\s*52\.5rem\)/u);
    expect(css).toMatch(/@media\s*\(min-resolution:\s*2dppx\)/u);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(css).toContain("animation-duration: 0.01ms");
    expect(css).toContain(":focus-visible");
    expect(css).not.toMatch(/display:\s*none[^}]*data-agent-mutation/u);
  });
});
