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

  it("offers target-Human Request actions beside the source and submits only structured intent", async () => {
    const workspace = document.createElement("main"); workspace.className = "room-authority-workspace";
    const timeline = document.createElement("section"); timeline.className = "room-authority-workspace__timeline";
    const source = document.createElement("article"); source.dataset.messageId = "message-1";
    source.dataset.messageRevision = "1"; timeline.append(source);
    const project = document.createElement("aside"); project.className = "room-authority-workspace__project";
    workspace.append(timeline, project); document.body.append(workspace);
    const ready = { status: "ready" as const, roomId: "room-1", snapshot: projectSnapshot(),
      viewerActorId: "human-2", connection: { status: "online" as const }, operation: { status: "idle" as const } };
    const submit = vi.fn(async () => ready);
    const bridge: ProjectLoopBridge = { getSurface: vi.fn(async () => ready), submit,
      onStateChanged: () => () => {} };
    const dispose = mountProjectLoopBridgeSurface(project, bridge, "room-1", { reducedMotion: true,
      onSearch: vi.fn(), onNavigateSegment: vi.fn(), onReauthenticate: vi.fn() });
    await vi.waitFor(() => expect(timeline.querySelector('[data-project-request-card="request-1"]')).not.toBeNull());
    const card = timeline.querySelector<HTMLElement>('[data-project-request-card="request-1"]')!;
    [...card.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "接受请求")?.click();
    expect(submit).toHaveBeenCalledWith({ roomId: "room-1", intent: expect.objectContaining({
      kind: "request.transition", action: "accept", factId: "request-1", expectedRevision: 3,
    }) });
    dispose(); workspace.remove();
  });

  it("re-attaches the Request card after an ordinary message timeline rerender", async () => {
    const workspace = document.createElement("main"); workspace.className = "room-authority-workspace";
    const timeline = document.createElement("section"); timeline.className = "room-authority-workspace__timeline";
    const source = document.createElement("article"); source.dataset.messageId = "message-1";
    source.dataset.messageRevision = "1"; timeline.append(source);
    const project = document.createElement("aside"); project.className = "room-authority-workspace__project";
    workspace.append(timeline, project); document.body.append(workspace);
    const ready = { status: "ready" as const, roomId: "room-1", snapshot: projectSnapshot(),
      viewerActorId: "human-2", connection: { status: "online" as const }, operation: { status: "idle" as const } };
    const bridge: ProjectLoopBridge = { getSurface: vi.fn(async () => ready), submit: vi.fn(async () => ready),
      onStateChanged: () => () => {} };
    const dispose = mountProjectLoopBridgeSurface(project, bridge, "room-1", { reducedMotion: true,
      onSearch: vi.fn(), onNavigateSegment: vi.fn(), onReauthenticate: vi.fn() });
    await vi.waitFor(() => expect(timeline.querySelector('[data-project-request-card="request-1"]')).not.toBeNull());
    const rerenderedSource = document.createElement("article"); rerenderedSource.dataset.messageId = "message-1";
    rerenderedSource.dataset.messageRevision = "1"; timeline.replaceChildren(rerenderedSource);
    await vi.waitFor(() => expect(rerenderedSource.nextElementSibling?.getAttribute("data-project-request-card"))
      .toBe("request-1"));
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
    await vi.waitFor(() => expect(project.querySelector('[data-category="requests"]')).not.toBeNull());
    project.querySelector<HTMLButtonElement>('[data-category="requests"]')?.click();
    project.querySelector<HTMLButtonElement>(".project-loop__content .project-loop__source")?.click();
    expect(source.dataset.projectSourceHighlight).toBe("exact-revision");
    expect(timeline.textContent).toContain("来源消息已撤回（tombstone），不显示原文");
    expect(timeline.textContent).not.toContain("Use stable project events");
    dispose(); workspace.remove();
  });

  it("fails closed when source kind or revision is not an exact match", async () => {
    const workspace = document.createElement("main"); workspace.className = "room-authority-workspace";
    const timeline = document.createElement("section"); timeline.className = "room-authority-workspace__timeline";
    const wrongRevision = document.createElement("article"); wrongRevision.dataset.messageId = "message-1";
    wrongRevision.dataset.messageRevision = "2"; wrongRevision.tabIndex = -1; timeline.append(wrongRevision);
    const wrongKind = document.createElement("article"); wrongKind.dataset.executionId = "message-1";
    wrongKind.dataset.executionRevision = "1"; wrongKind.tabIndex = -1; timeline.append(wrongKind);
    const project = document.createElement("aside"); project.className = "room-authority-workspace__project";
    workspace.append(timeline, project); document.body.append(workspace);
    const ready = { status: "ready" as const, roomId: "room-1", snapshot: projectSnapshot(),
      viewerActorId: "human-1", connection: { status: "online" as const }, operation: { status: "idle" as const } };
    const bridge: ProjectLoopBridge = { getSurface: vi.fn(async () => ready), submit: vi.fn(async () => ready),
      onStateChanged: () => () => {} };
    const dispose = mountProjectLoopBridgeSurface(project, bridge, "room-1", { reducedMotion: false,
      onSearch: vi.fn(), onNavigateSegment: vi.fn(), onReauthenticate: vi.fn() });
    await vi.waitFor(() => expect(project.querySelector('[data-category="requests"]')).not.toBeNull());
    project.querySelector<HTMLButtonElement>('[data-category="requests"]')?.click();
    project.querySelector<HTMLButtonElement>(".project-loop__content .project-loop__source")?.click();
    expect(project.querySelector<HTMLElement>(".project-loop")?.dataset.projectSourceLookup)
      .toBe("exact-source-unavailable");
    expect(wrongRevision.dataset.projectSourceHighlight).toBeUndefined();
    expect(wrongKind.dataset.projectSourceHighlight).toBeUndefined();
    expect(project.querySelector(".project-loop__source-status")?.textContent).toContain("未打开其他对象");
    dispose(); workspace.remove();
  });
});
