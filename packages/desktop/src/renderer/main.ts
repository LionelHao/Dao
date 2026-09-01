import { mountDesktopRendererEntry } from "./entry.js";

const root = document.querySelector<HTMLElement>("#app");

if (root === null) {
  throw new Error("Desktop renderer requires an #app root element.");
}

let dispose: (() => void) | undefined;
const render = (): void => {
  dispose?.();
  dispose = mountDesktopRendererEntry(
    root,
    window.location.search,
    window.dao?.identity,
    window.dao?.governance,
    window.dao?.messageAuthority,
    undefined,
    window.dao?.attachmentAuthority,
    window.dao?.memoryAuthority,
    window.dao?.agentSettings,
    window.dao?.invocation,
    window.dao?.projectLoop,
    window.dao?.toolSafety,
    window.dao?.notificationCenter,
    window.dao?.notificationToolResult,
    window.dao?.notificationExecutionResult,
  );
};

window.addEventListener("popstate", render);
window.addEventListener("beforeunload", () => {
  window.removeEventListener("popstate", render);
  dispose?.();
}, { once: true });
render();
