import type { ToolSafetyBridge, ToolSafetyRemoteState } from "../../tool-safety/contracts.js";
import { renderToolSafetySurface } from "./surface.js";

export interface ToolSafetyHostActions {
  openSource(sourceRef: string): void;
  newInvocation(): void;
  reauthenticate(): void;
}

export function mountToolSafetyBridgeSurface(
  root: HTMLElement,
  bridge: ToolSafetyBridge,
  roomId: string,
  host: ToolSafetyHostActions,
): () => void {
  let disposed = false;
  const drafts = new Map<string, string>();
  let pendingFocusToolCallId: string | undefined;
  let awaitingAuthorityCompletion = false;
  const focusedErrorRequests = new Set<string>();
  const render = (state: ToolSafetyRemoteState): void => {
    if (disposed || state.roomId !== roomId) return;
    const active = root.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement : undefined;
    const activeCard = active?.closest<HTMLElement>("[data-tool-safety-tool-call-id]");
    const preserveFocus = activeCard === null || activeCard === undefined ? undefined : {
      toolCallId: activeCard.dataset.toolSafetyToolCallId!,
      selector: active?.matches("[data-tool-safety-state-heading]") ? "[data-tool-safety-state-heading]"
        : active?.matches("[data-recovery-action]") ? "[data-recovery-action]"
          : active?.matches("[data-tool-safety-evidence]") ? "[data-tool-safety-evidence]" : undefined,
    };
    const panel = document.createElement("section");
    panel.className = "tool-safety-rail";
    panel.dataset.toolSafetyRail = roomId;
    const heading = document.createElement("h2");
    heading.textContent = "工具安全";
    panel.append(heading);
    if (state.cards.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = state.connection.status === "revoked"
        ? "Room 或 session 权限已撤销；工具安全 projection 已清除。"
        : state.connection.status === "repairing" ? "正在 repair 工具安全 projection。"
          : "当前没有需要显示的工具调用。";
      empty.setAttribute("role", state.connection.status === "revoked" ? "alert" : "status");
      panel.append(empty);
    }
    let focus: Readonly<{ toolCallId: string; kind: "heading" | "recovery" | "evidence" }> | undefined;
    if (pendingFocusToolCallId !== undefined && state.operation.status === "error" &&
        !focusedErrorRequests.has(state.operation.requestId)) {
      focusedErrorRequests.add(state.operation.requestId);
      awaitingAuthorityCompletion = false;
      focus = { toolCallId: pendingFocusToolCallId,
        kind: state.operation.statusCode === 409 || state.operation.statusCode === 410 ? "recovery"
          : state.operation.action === "review" ? "evidence" : "heading" };
    } else if (pendingFocusToolCallId !== undefined && state.operation.status === "idle" &&
        awaitingAuthorityCompletion) {
      focus = { toolCallId: pendingFocusToolCallId, kind: "heading" };
      pendingFocusToolCallId = undefined;
      awaitingAuthorityCompletion = false;
    }
    for (const card of state.cards) {
      const cardRoot = document.createElement("div");
      cardRoot.dataset.toolSafetyToolCallId = card.toolCallId;
      const draft = card.dispatchId === undefined ? undefined : drafts.get(card.dispatchId);
      renderToolSafetySurface(cardRoot, {
        connection: state.connection,
        card,
        operation: state.operation,
        ...(draft === undefined ? {} : { reviewDraft: { evidenceSummary: draft } }),
      }, {
        submit(command) {
          pendingFocusToolCallId = card.toolCallId;
          awaitingAuthorityCompletion = true;
          if (command.type === "tool.outcome.review") drafts.set(command.dispatchId, command.evidenceSummary);
          void bridge.submit({ roomId, command }).catch(() => undefined);
        },
        repair() { void bridge.repair({ roomId }).catch(() => undefined); },
        reauthenticate: host.reauthenticate,
        newInvocation: host.newInvocation,
        openSource: host.openSource,
      });
      cardRoot.querySelector<HTMLTextAreaElement>("[data-tool-safety-evidence]")?.addEventListener("input", (event) => {
        if (card.dispatchId !== undefined && event.currentTarget instanceof HTMLTextAreaElement) {
          drafts.set(card.dispatchId, event.currentTarget.value);
        }
      });
      panel.append(cardRoot);
    }
    root.replaceChildren(panel);
    if (focus !== undefined) {
      const cardRoot = [...panel.querySelectorAll<HTMLElement>("[data-tool-safety-tool-call-id]")]
        .find((candidate) => candidate.dataset.toolSafetyToolCallId === focus!.toolCallId);
      const target = focus.kind === "recovery"
        ? cardRoot?.querySelector<HTMLElement>("[data-recovery-action]")
        : focus.kind === "evidence" ? cardRoot?.querySelector<HTMLElement>("[data-tool-safety-evidence]")
          : cardRoot?.querySelector<HTMLElement>("[data-tool-safety-state-heading]");
      target?.focus({ preventScroll: true });
    } else if (preserveFocus?.selector !== undefined) {
      const cardRoot = [...panel.querySelectorAll<HTMLElement>("[data-tool-safety-tool-call-id]")]
        .find((candidate) => candidate.dataset.toolSafetyToolCallId === preserveFocus.toolCallId);
      cardRoot?.querySelector<HTMLElement>(preserveFocus.selector)?.focus({ preventScroll: true });
    }
  };
  const unsubscribe = bridge.onStateChanged(({ roomId: changedRoomId, state }) => {
    if (changedRoomId === roomId) render(state);
  });
  void bridge.getSurface({ roomId }).then(render).catch(() => {
    if (disposed) return;
    const alert = document.createElement("p");
    alert.setAttribute("role", "alert");
    alert.textContent = "503 · 无法载入工具安全权威 projection；所有写操作保持关闭。";
    root.replaceChildren(alert);
  });
  return () => { disposed = true; unsubscribe(); drafts.clear(); };
}
