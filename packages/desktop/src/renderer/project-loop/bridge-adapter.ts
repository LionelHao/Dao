import type { ProjectLoopBridge } from "../../project-loop/contracts.js";
import type { MessageAuthorityBridge } from "../../message-authority/contracts.js";
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
    messageBridge?: MessageAuthorityBridge;
  }>,
): () => void {
  let active = true;
  let authoritySequence = 0;
  let current: ProjectLoopRemoteState = { status: "loading", roomId };
  let timelineObserver: MutationObserver | undefined;
  let observedTimeline: HTMLElement | undefined;
  let lastTimelineControlId: string | undefined;
  let lastTimelineRequestId: string | undefined;
  let historicalSource: HTMLElement | undefined;
  let sourceLookupSequence = 0;
  const timelineTransferDrafts = new Map<string, string>();
  const rememberTimelineFocus = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement)) return;
    lastTimelineControlId = event.target.dataset.projectControlId;
    lastTimelineRequestId = event.target.closest<HTMLElement>("[data-project-request-card]")
      ?.dataset.projectRequestCard;
  };

  const renderTimelineRequests = (): void => {
    const workspace = root.closest(".room-authority-workspace");
    const timeline = workspace?.querySelector<HTMLElement>(".room-authority-workspace__timeline");
    if (timeline === null || timeline === undefined) return;
    if (observedTimeline !== timeline) {
      observedTimeline?.removeEventListener("focusin", rememberTimelineFocus);
      observedTimeline = timeline;
      observedTimeline.addEventListener("focusin", rememberTimelineFocus);
    }
    const priorFocus = document.activeElement instanceof HTMLElement && timeline.contains(document.activeElement)
      ? document.activeElement : null;
    const focusedControlId = priorFocus?.dataset.projectControlId ??
      (document.activeElement === document.body ? lastTimelineControlId : undefined);
    const focusedRequestId = priorFocus?.closest<HTMLElement>("[data-project-request-card]")
      ?.dataset.projectRequestCard ?? (document.activeElement === document.body ? lastTimelineRequestId : undefined);
    for (const input of timeline.querySelectorAll<HTMLInputElement>("[data-timeline-request-transfer-target]")) {
      const requestId = input.dataset.timelineRequestTransferTarget;
      if (requestId !== undefined) timelineTransferDrafts.set(requestId, input.value);
    }
    timelineObserver?.disconnect();
    for (const prior of timeline.querySelectorAll("[data-project-request-card]")) prior.remove();
    if (current.status !== "ready") {
      historicalSource?.remove(); historicalSource = undefined;
      return;
    }
    for (const request of current.snapshot.requests) {
      const source = request.provenance.source;
      if (source.kind !== "message") continue;
      const anchor = [...timeline.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => candidate.dataset.messageId === source.sourceId &&
          candidate.dataset.messageRevision === String(source.sourceRevision)) ?? null;
      if (anchor === null) continue;
      const card = document.createElement("aside");
      card.className = "project-loop__timeline-request";
      card.dataset.projectRequestCard = request.requestId;
      card.dataset.sourceRevision = String(source.sourceRevision);
      card.tabIndex = -1;
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
      const action = (label: string, intent: Extract<Parameters<ProjectLoopBridge["submit"]>[0]["intent"],
        { kind: "request.transition" }>): HTMLButtonElement => {
        const value = document.createElement("button"); value.type = "button"; value.textContent = label;
        value.dataset.projectControlId = `timeline:${request.requestId}:${intent.action}`;
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
        input.dataset.projectControlId = `timeline:${request.requestId}:transfer-target`;
        input.value = timelineTransferDrafts.get(request.requestId) ?? "";
        input.addEventListener("input", () => timelineTransferDrafts.set(request.requestId, input.value));
        label.append(input); card.append(label);
        const transfer = document.createElement("button"); transfer.type = "button"; transfer.textContent = "提交转交";
        transfer.dataset.projectControlId = `timeline:${request.requestId}:transfer`;
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
    if (focusedControlId !== undefined) {
      const replacement = [...timeline.querySelectorAll<HTMLElement>("[data-project-control-id]")]
        .find((candidate) => candidate.dataset.projectControlId === focusedControlId &&
          (!(candidate instanceof HTMLButtonElement || candidate instanceof HTMLInputElement) || !candidate.disabled));
      if (replacement !== undefined) replacement.focus();
      else [...timeline.querySelectorAll<HTMLElement>("[data-project-request-card]")]
        .find((candidate) => candidate.dataset.projectRequestCard === focusedRequestId)?.focus();
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
      const lookupSequence = ++sourceLookupSequence;
      historicalSource?.remove(); historicalSource = undefined;
      const host = root.closest(".room-authority-workspace") ?? root;
      const compactSegment = source.kind === "message" || source.kind === "attachment"
        ? "timeline" : "project";
      const compactControl = host.querySelector<HTMLButtonElement>(
        `[data-compact-segment-target="${compactSegment}"]`,
      );
      if (compactControl !== null) compactControl.click();
      else options.onNavigateSegment(compactSegment);
      const railTab = source.kind === "memory" ? "memory"
        : source.kind === "agent_execution" ? "agent"
          : source.kind === "project_fact" ? "project" : undefined;
      if (railTab !== undefined) {
        host.querySelector<HTMLButtonElement>(`[data-authority-rail-tab="${railTab}"]`)?.click();
      }
      if (source.kind === "project_fact" && current.status === "ready") {
        const category = current.snapshot.goals.some((fact) => fact.goalId === source.sourceId &&
            fact.revision === source.sourceRevision) ? "goals"
          : current.snapshot.decisions.some((fact) => fact.decisionId === source.sourceId &&
            fact.revision === source.sourceRevision) ? "decisions"
          : current.snapshot.requests.some((fact) => fact.requestId === source.sourceId &&
            fact.revision === source.sourceRevision) ? "requests"
          : current.snapshot.obstacles.some((fact) => fact.obstacleId === source.sourceId &&
            fact.revision === source.sourceRevision) ? "obstacles"
          : current.snapshot.nextActions.some((fact) => fact.nextActionId === source.sourceId &&
            fact.revision === source.sourceRevision) ? "next_actions" : undefined;
        if (category !== undefined) {
          root.querySelector<HTMLButtonElement>(`[data-category="${category}"]`)?.click();
        }
      }
      const candidates = source.kind === "message"
        ? host.querySelectorAll<HTMLElement>("[data-message-id]")
        : source.kind === "agent_execution"
          ? host.querySelectorAll<HTMLElement>("[data-execution-id]")
          : source.kind === "attachment"
            ? host.querySelectorAll<HTMLElement>("[data-attachment-id]")
          : host.querySelectorAll<HTMLElement>("[data-source-id]:not(.project-loop__source)");
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
      const reveal = (target: HTMLElement | null, unavailable?: string): void => {
        if (!active || lookupSequence !== sourceLookupSequence) return;
        const visibleTarget = target?.closest("[hidden]") === null ? target : null;
        const panel = root.querySelector<HTMLElement>(".project-loop");
        if (panel !== null) panel.dataset.projectSourceLookup = visibleTarget === null
          ? "exact-source-unavailable" : "exact";
        const status = root.querySelector<HTMLElement>(".project-loop__source-status");
        if (status !== null) status.textContent = visibleTarget === null
          ? (unavailable ?? "无法定位精确的来源类型与版本；未打开其他对象。")
          : `已定位精确来源 ${source.kind}:${source.sourceId} r${source.sourceRevision}。`;
        visibleTarget?.scrollIntoView?.({ block: "center" });
        if (visibleTarget !== null) {
          visibleTarget.dataset.projectSourceHighlight = "exact-revision";
          visibleTarget.tabIndex = -1;
          visibleTarget.focus();
        }
      };
      const visibleCandidate = candidate?.closest("[hidden]") === null ? candidate : null;
      if (visibleCandidate !== null || source.kind !== "message" || options.messageBridge === undefined) {
        reveal(visibleCandidate); return;
      }
      const timeline = host.querySelector<HTMLElement>(".room-authority-workspace__timeline");
      const currentMessage = [...(timeline?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])]
        .find((item) => item.dataset.messageId === source.sourceId);
      if (currentMessage?.classList.contains("message-authority__message--tombstone") === true) {
        reveal(null, "来源消息已撤回；未载入或显示历史正文。"); return;
      }
      const status = root.querySelector<HTMLElement>(".project-loop__source-status");
      if (status !== null) status.textContent = `正在载入精确来源 message:${source.sourceId} r${source.sourceRevision}。`;
      void options.messageBridge.revisionsQuery({
        type: "message.revisions.query", roomId, messageId: source.sourceId,
        afterRevision: source.sourceRevision - 1, limit: 1,
      }).then((result) => {
        if (!active || lookupSequence !== sourceLookupSequence) return;
        if (result.type === "message.error") {
          reveal(null, `无法载入精确来源；${result.status} ${result.code}。`); return;
        }
        const revision = result.roomId === roomId && result.messageId === source.sourceId
          ? result.revisions.find((item) => item.messageId === source.sourceId &&
              item.revision === source.sourceRevision) : undefined;
        if (revision === undefined || timeline === null) { reveal(null); return; }
        const historical = document.createElement("article");
        historical.className = "project-loop__historical-message-source";
        historical.dataset.projectHistoricalSource = "true";
        historical.dataset.messageId = revision.messageId;
        historical.dataset.messageRevision = String(revision.revision);
        historical.setAttribute("aria-label", `消息 ${revision.messageId} 的历史版本 ${revision.revision}`);
        const metadata = document.createElement("p");
        metadata.textContent = `历史消息版本 r${revision.revision} · ${revision.revisedByActorId} · ${revision.revisedAt}`;
        const body = document.createElement("p"); body.textContent = revision.body;
        historical.append(metadata, body);
        if (currentMessage === undefined) timeline.append(historical);
        else currentMessage.insertAdjacentElement("beforebegin", historical);
        historicalSource = historical;
        reveal(historical);
      }).catch(() => reveal(null, "无法载入精确来源；请重试。"));
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
    observedTimeline?.removeEventListener("focusin", rememberTimelineFocus);
    sourceLookupSequence += 1;
    historicalSource?.remove(); historicalSource = undefined;
    unsubscribe();
  };
}
