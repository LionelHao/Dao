import type { MemoryAuthorityBridge } from "../../memory-authority/contracts.js";
import { createMemoryAuthorityClient } from "./client.js";
import { createMemoryAuthorityController } from "./controller.js";
import { mountMemoryAuthorityBridgeSurface } from "./bridge-adapter.js";

function failClosed(root: HTMLElement, message: string): void {
  const section = document.createElement("section");
  section.className = "memory-authority-panel memory-authority-panel--locked";
  section.dataset.memoryPanelLocked = "true";
  section.setAttribute("role", "alert");
  const heading = document.createElement("h2");
  heading.textContent = "重要记忆暂不可用";
  const detail = document.createElement("p");
  detail.textContent = message;
  section.append(heading, detail);
  root.replaceChildren(section);
}

function focusAuthoritySource(navigation: Readonly<{
  kind: "message" | "tombstone" | "attachment" | "project_fact";
  messageId?: string;
  attachmentId?: string;
}>): void {
  const attribute = navigation.kind === "attachment" ? "data-attachment-id" : "data-message-id";
  const id = navigation.kind === "attachment" ? navigation.attachmentId : navigation.messageId;
  if (id === undefined) return;
  const target = [...document.querySelectorAll<HTMLElement>(`[${attribute}]`)]
    .find((candidate) => candidate.getAttribute(attribute) === id);
  if (target === undefined) return;
  target.tabIndex = -1;
  target.scrollIntoView?.({ block: "center", behavior: "auto" });
  target.focus({ preventScroll: true });
}

export function mountDesktopMemoryAuthoritySurface(
  root: HTMLElement,
  bridge: MemoryAuthorityBridge,
  roomId: string,
  options: Readonly<{
    reducedMotion: boolean;
    createRequestId?: (operation: string) => string;
  }>,
): () => void {
  const loading = document.createElement("section");
  loading.className = "memory-authority-panel";
  loading.dataset.memoryPanelLoading = "true";
  loading.setAttribute("aria-label", "重要记忆 · 5 类");
  loading.setAttribute("aria-busy", "true");
  const heading = document.createElement("h2");
  heading.textContent = "重要记忆 · 5 类";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "正在加载权威记忆…";
  loading.append(heading, status);
  root.replaceChildren(loading);

  let disposed = false;
  let disposeSurface: (() => void) | undefined;
  let controller: ReturnType<typeof createMemoryAuthorityController> | undefined;
  void bridge.context({ roomId }).then((context) => {
    if (disposed) return;
    const client = createMemoryAuthorityClient(bridge);
    controller = createMemoryAuthorityController({
      client,
      createRequestId: (operation) => options.createRequestId?.(operation) ??
        `memory-${operation}-${globalThis.crypto.randomUUID()}`,
    });
    disposeSurface = mountMemoryAuthorityBridgeSurface(root, controller, {
      ...context,
      reducedMotion: options.reducedMotion,
    }, {
      onNavigateSource(intent) {
        focusAuthoritySource(intent.navigation);
      },
    });
  }).catch(() => {
    if (!disposed) failClosed(root, "聊天仍可继续；请检查连接或 Room 权限后重试。");
  });

  return () => {
    if (disposed) return;
    disposed = true;
    disposeSurface?.();
    controller?.close();
  };
}
