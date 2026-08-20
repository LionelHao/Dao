import {
  type MemoryAuthorityController,
  type MemoryAuthorityControllerContext,
  type MemoryAuthorityControllerSnapshot,
  type MemoryAuthoritySourceIntent,
} from "./controller.js";
import { renderMemoryAuthoritySurface } from "./surface.js";
import { createMemoryAuthorityViewModel } from "./view-model.js";

export interface MemoryAuthorityBridgeSurfaceActions {
  readonly onNavigateSource: (intent: MemoryAuthoritySourceIntent) => void;
}

function boundedAnnouncement(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= 256) return value;
  let result = "";
  for (const point of value) {
    if (encoder.encode(result + point).byteLength > 256) break;
    result += point;
  }
  return result;
}

function announcement(snapshot: MemoryAuthorityControllerSnapshot): Readonly<{
  key: string;
  text: string;
  state: string;
}> {
  const view = createMemoryAuthorityViewModel(snapshot.panel);
  if (snapshot.panel.operation.status === "acknowledged") {
    const command = snapshot.panel.operation.command === "dispute"
      ? "争议"
      : snapshot.panel.operation.command === "resolve"
        ? "解决"
        : "重试";
    return {
      key: `acknowledged:${snapshot.panel.operation.command}:${snapshot.panel.operation.requestId}`,
      text: `${command}请求已确认，权威记忆状态将由后续事件更新。`,
      state: view.visibleState,
    };
  }
  return { key: `state:${view.visibleState}`, text: view.liveAnnouncement, state: view.visibleState };
}

export function mountMemoryAuthorityBridgeSurface(
  root: HTMLElement,
  controller: MemoryAuthorityController,
  context: MemoryAuthorityControllerContext,
  actions: MemoryAuthorityBridgeSurfaceActions,
): () => void {
  let disposed = false;
  let lastAnnouncementKey: string | undefined;
  let previousState: string | undefined;

  const render = (snapshot: MemoryAuthorityControllerSnapshot): void => {
    if (disposed || snapshot.roomId !== context.roomId || snapshot.accessEpoch < context.accessEpoch) return;
    renderMemoryAuthoritySurface(root, snapshot.panel, {
      onNavigateSource(navigation): void {
        const intent = controller.navigate({ roomId: snapshot.roomId, navigation });
        if (intent !== undefined) actions.onNavigateSource(intent);
      },
      onDispute(intent): void {
        controller.dispute({ roomId: snapshot.roomId, ...intent });
      },
      onResolve(intent): void {
        controller.resolve({ roomId: snapshot.roomId, ...intent, resolution: "re_evaluate" });
      },
      onRetry(): void {
        controller.retry({ roomId: snapshot.roomId });
      },
    });
    const next = announcement(snapshot);
    const live = root.querySelector<HTMLElement>("[data-memory-live]");
    if (live !== null) {
      const repairCompleted = (previousState === "repairing" || previousState === "repair-failed") &&
        next.state !== "repairing" && next.state !== "repair-failed";
      const key = repairCompleted ? `repair-completed:${snapshot.accessEpoch}` : next.key;
      const value = repairCompleted ? "重要记忆修复完成。" : next.text;
      live.textContent = key === lastAnnouncementKey ? "" : boundedAnnouncement(value);
      lastAnnouncementKey = key;
    }
    previousState = next.state;
  };

  const unsubscribe = controller.subscribe(context.roomId, render);
  const current = controller.current(context.roomId);
  if (current !== undefined) render(current);
  void controller.open(context).catch(() => undefined);

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
  };
}
