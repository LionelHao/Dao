import { mountDesktopRendererEntry } from "./entry.js";

const root = document.querySelector<HTMLElement>("#app");

if (root === null) {
  throw new Error("Desktop renderer requires an #app root element.");
}

const dispose = mountDesktopRendererEntry(
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
);
if (dispose !== undefined) {
  window.addEventListener("beforeunload", dispose, { once: true });
}
