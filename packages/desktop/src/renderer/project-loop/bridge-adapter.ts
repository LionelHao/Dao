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
  let timelineObserver: MutationObserver | undefined;

  const renderTimelineRequests = (): void => {
    const workspace = root.closest(".room-authority-workspace");
    const timeline = workspace?.querySelector<HTMLElement>(".room-authority-workspace__timeline");
    if (timeline === null || timeline === undefined) return;
    timelineObserver?.disconnect();
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
      const summary = document.createElement("p");
      summary.textContent = tombstone
        ? `REQUEST · ${request.status} · 来源消息已撤回（tombstone），不显示原文`
        : `REQUEST · ${request.status} · ${request.requester.actorId} → ${request.target.actorId}`;
      card.append(summary);
      const mutationDisabled = current.connection.status !== "online" ||
        current.operation.status === "submitting" || current.operation.status === "failed" &&
          (current.operation.error.status === 401 || current.operation.error.status === 403 ||
            current.operation.error.status === 410);
      const submit = (intent: Parameters<ProjectLoopBridge["submit"]>[0]["intent"]): void => {
        void bridge.submit({ roomId, intent }).then(apply).catch(() => {
          if (!active) return;
          current = { status: "locked", roomId,
            error: { status: 503, code: "project_bridge_unavailable" } };
          render();
        });
      };
      const action = (label: string, intent: Parameters<ProjectLoopBridge["submit"]>[0]["intent"]): HTMLButtonElement => {
        const value = document.createElement("button"); value.type = "button"; value.textContent = label;
        value.disabled = mutationDisabled; value.addEventListener("click", () => submit(intent)); return value;
      };
      if (request.status === "pending_acceptance" && request.target.actorId === current.viewerActorId) {
        card.append(action("接受请求", { kind: "request.transition",
          intentId: `timeline:accept:${request.requestId}:${request.revision}`,
          factId: request.requestId, expectedRevision: request.revision, action: "accept" }));
        card.append(action("拒绝请求", { kind: "request.transition",
          intentId: `timeline:reject:${request.requestId}:${request.revision}`,
          factId: request.requestId, expectedRevision: request.revision, action: "reject",
          reason: "Rejected by target Human from Desktop timeline" }));
        const label = document.createElement("label"); label.textContent = "转交给 Human actorId";
        const input = document.createElement("input"); input.type = "text"; input.autocomplete = "off";
        input.dataset.timelineRequestTransferTarget = request.requestId; input.disabled = mutationDisabled;
        label.append(input); card.append(label);
        const transfer = document.createElement("button"); transfer.type = "button"; transfer.textContent = "提交转交";
        transfer.disabled = mutationDisabled; transfer.addEventListener("click", () => {
          const actorId = input.value.trim();
          if (actorId.length === 0) { input.setCustomValidity("请输入目标 Human actorId"); input.reportValidity(); return; }
          input.setCustomValidity(""); submit({ kind: "request.transition",
            intentId: `timeline:transfer:${request.requestId}:${request.revision}:${actorId}`,
            factId: request.requestId, expectedRevision: request.revision, action: "transfer",
            target: { kind: "human", actorId }, reason: "Transferred by target Human from Desktop timeline" });
        });
        card.append(transfer);
      }
      if (request.status === "pending_acceptance" && request.requester.actorId === current.viewerActorId) {
        card.append(action("取消请求", { kind: "request.transition",
          intentId: `timeline:cancel:${request.requestId}:${request.revision}`,
          factId: request.requestId, expectedRevision: request.revision, action: "cancel",
          reason: "Cancelled by requester Human from Desktop timeline" }));
      }
      anchor.insertAdjacentElement("afterend", card);
    }
    timelineObserver ??= new MutationObserver(() => queueMicrotask(renderTimelineRequests));
    timelineObserver.observe(timeline, { childList: true, subtree: true });
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
      const candidates = source.kind === "message"
        ? host.querySelectorAll<HTMLElement>("[data-message-id]")
        : source.kind === "agent_execution"
          ? host.querySelectorAll<HTMLElement>("[data-execution-id]")
          : source.kind === "attachment"
            ? host.querySelectorAll<HTMLElement>("[data-attachment-id]")
          : host.querySelectorAll<HTMLElement>("[data-source-id]");
      const candidate = [...candidates].find((item) => {
        const id = source.kind === "message" ? item.dataset.messageId
          : source.kind === "agent_execution" ? item.dataset.executionId
            : source.kind === "attachment" ? item.dataset.attachmentId : item.dataset.sourceId;
        const revision = source.kind === "message" ? item.dataset.messageRevision
          : source.kind === "agent_execution" ? item.dataset.executionRevision
            : source.kind === "attachment" ? item.dataset.attachmentRevision : item.dataset.sourceRevision;
        const kindMatches = source.kind === "message" || source.kind === "agent_execution" ||
          source.kind === "attachment" ||
          item.dataset.sourceKind === source.kind;
        return id === source.sourceId && revision === String(source.sourceRevision) && kindMatches;
      }) ?? null;
      const panel = root.querySelector<HTMLElement>(".project-loop");
      if (panel !== null) panel.dataset.projectSourceLookup = candidate === null ? "exact-source-unavailable" : "exact";
      const status = root.querySelector<HTMLElement>(".project-loop__source-status");
      if (status !== null) status.textContent = candidate === null
        ? "无法定位精确的来源类型与版本；未打开其他对象。"
        : `已定位精确来源 ${source.kind}:${source.sourceId} r${source.sourceRevision}。`;
      candidate?.scrollIntoView?.({ block: "center" });
      if (candidate !== null) candidate.dataset.projectSourceHighlight = "exact-revision";
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
    timelineObserver?.disconnect();
    unsubscribe();
  };
}
