import type { ProjectLoopBridge } from "../../project-loop/contracts.js";
import type { ProjectLoopRemoteState } from "./view-model.js";
import { renderProjectLoopSurface, type ProjectLoopSurfaceActions } from "./surface.js";

export function mountProjectLoopBridgeSurface(
  root: HTMLElement,
  bridge: ProjectLoopBridge,
  roomId: string,
  options: Readonly<{
    reducedMotion: boolean;
    onSearch: () => void;
    onNavigateSegment: ProjectLoopSurfaceActions["onNavigateSegment"];
    onReauthenticate: () => void;
  }>,
): () => void {
  let active = true;
  let authoritySequence = 0;
  let current: ProjectLoopRemoteState = { status: "loading", roomId };

  const renderTimelineRequests = (): void => {
    const workspace = root.closest(".room-authority-workspace");
    const timeline = workspace?.querySelector<HTMLElement>(".room-authority-workspace__timeline");
    if (timeline === null || timeline === undefined) return;
    for (const prior of timeline.querySelectorAll("[data-project-request-card]")) prior.remove();
    if (current.status !== "ready") return;
    for (const request of current.snapshot.requests) {
      const source = request.provenance.source;
      if (source.kind !== "message") continue;
      const anchor = [...timeline.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => candidate.dataset.messageId === source.sourceId) ?? null;
      if (anchor === null) continue;
      const card = document.createElement("aside");
      card.className = "project-loop__timeline-request";
      card.dataset.projectRequestCard = request.requestId;
      card.dataset.sourceRevision = String(source.sourceRevision);
      card.setAttribute("aria-label", `Request ${request.title}`);
      const tombstone = anchor.classList.contains("message-authority__message--tombstone");
      card.textContent = tombstone
        ? `REQUEST · ${request.status} · 来源消息已撤回（tombstone），不显示原文`
        : `REQUEST · ${request.status} · ${request.requester.actorId} → ${request.target.actorId}`;
      anchor.insertAdjacentElement("afterend", card);
    }
  };

  const render = (): void => { renderProjectLoopSurface(root, current, {
    onIntent(intent) {
      void bridge.submit({ roomId, intent }).then(apply).catch(() => {
        if (!active) return;
        current = { status: "locked", roomId,
          error: { status: 503, code: "project_bridge_unavailable" } };
        render();
      });
    },
    onRetry() { void refresh(); },
    onReauthenticate: options.onReauthenticate,
    onSearch: options.onSearch,
    onNavigateSegment: options.onNavigateSegment,
    onOpenSource(source) {
      const host = root.closest(".room-authority-workspace") ?? root;
      const candidate = [...host.querySelectorAll<HTMLElement>("[data-message-id],[data-execution-id],[data-source-id]")]
        .find((item) => item.dataset.messageId === source.sourceId ||
          item.dataset.executionId === source.sourceId || item.dataset.sourceId === source.sourceId) ?? null;
      candidate?.scrollIntoView?.({ block: "center" });
      if (candidate !== null) candidate.dataset.projectSourceHighlight =
        candidate.dataset.messageRevision === String(source.sourceRevision) ? "exact-revision" : "revision-mismatch";
      candidate?.focus();
    },
  }, { reducedMotion: options.reducedMotion }); renderTimelineRequests(); };

  const apply = (state: ProjectLoopRemoteState): void => {
    authoritySequence += 1;
    if (state.roomId !== roomId) return;
    current = state;
    render();
  };
  const refresh = async (): Promise<void> => {
    const startedAt = authoritySequence;
    try {
      const state = await bridge.getSurface({ roomId });
      if (active && authoritySequence === startedAt) apply(state);
    } catch {
      if (active && authoritySequence === startedAt) apply({
        status: "locked", roomId, error: { status: 503, code: "project_bridge_unavailable" },
      });
    }
  };
  render();
  const unsubscribe = bridge.onStateChanged((envelope) => {
    if (active && envelope.roomId === roomId) apply(envelope.state);
  });
  void refresh();
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
  };
}
