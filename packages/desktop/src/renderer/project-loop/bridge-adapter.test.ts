import { describe, expect, it, vi } from "vitest";
import type { ProjectLoopBridge } from "../../project-loop/contracts.js";
import { projectSnapshot } from "../../project-loop/test-fixture.js";
import { mountProjectLoopBridgeSurface } from "./bridge-adapter.js";

describe("FT-09 Project Loop timeline integration", () => {
  it("anchors a structured Request card adjacent to its source without parsing message body", async () => {
    const workspace = document.createElement("main"); workspace.className = "room-authority-workspace";
    const timeline = document.createElement("section"); timeline.className = "room-authority-workspace__timeline";
    const source = document.createElement("article"); source.dataset.messageId = "message-1";
    source.dataset.messageRevision = "1"; source.textContent = "opaque body not parsed"; timeline.append(source);
    const project = document.createElement("aside"); project.className = "room-authority-workspace__project";
    workspace.append(timeline, project); document.body.append(workspace);
    const ready = { status: "ready" as const, roomId: "room-1", snapshot: projectSnapshot(),
      viewerActorId: "human-1", connection: { status: "online" as const }, operation: { status: "idle" as const } };
    const bridge: ProjectLoopBridge = { getSurface: vi.fn(async () => ready), submit: vi.fn(async () => ready),
      onStateChanged: () => () => {} };
    const dispose = mountProjectLoopBridgeSurface(project, bridge, "room-1", { reducedMotion: true,
      onSearch: vi.fn(), onNavigateSegment: vi.fn(), onReauthenticate: vi.fn() });
    await vi.waitFor(() => expect(timeline.querySelector('[data-project-request-card="request-1"]')).not.toBeNull());
    expect(source.nextElementSibling?.textContent).toContain("REQUEST · pending_acceptance · human-1 → human-2");
    expect(source.nextElementSibling?.textContent).not.toContain("opaque body");
    dispose(); workspace.remove();
  });

  it("deep-links the exact source revision and keeps recalled source content tombstoned", async () => {
    const workspace = document.createElement("main"); workspace.className = "room-authority-workspace";
    const timeline = document.createElement("section"); timeline.className = "room-authority-workspace__timeline";
    const source = document.createElement("article");
    source.className = "message-authority__message--tombstone"; source.dataset.messageId = "message-1";
    source.dataset.messageRevision = "1"; source.tabIndex = -1; source.textContent = "消息已撤回"; timeline.append(source);
    const project = document.createElement("aside"); project.className = "room-authority-workspace__project";
    workspace.append(timeline, project); document.body.append(workspace);
    const ready = { status: "ready" as const, roomId: "room-1", snapshot: projectSnapshot(),
      viewerActorId: "human-1", connection: { status: "online" as const }, operation: { status: "idle" as const } };
    const bridge: ProjectLoopBridge = { getSurface: vi.fn(async () => ready), submit: vi.fn(async () => ready),
      onStateChanged: () => () => {} };
    const dispose = mountProjectLoopBridgeSurface(project, bridge, "room-1", { reducedMotion: false,
      onSearch: vi.fn(), onNavigateSegment: vi.fn(), onReauthenticate: vi.fn() });
    await vi.waitFor(() => expect(project.querySelector(".project-loop__source")).not.toBeNull());
    project.querySelector<HTMLButtonElement>(".project-loop__source")?.click();
    expect(source.dataset.projectSourceHighlight).toBe("exact-revision");
    expect(timeline.textContent).toContain("来源消息已撤回（tombstone），不显示原文");
    expect(timeline.textContent).not.toContain("Use stable project events");
    dispose(); workspace.remove();
  });
});
