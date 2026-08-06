import { renderEmptyGroupChat, renderVisualSeparationPreview } from "./app.js";

const root = document.querySelector<HTMLElement>("#app");

if (root === null) {
  throw new Error("Desktop renderer requires an #app root element.");
}

if (new URLSearchParams(window.location.search).has("visual-review")) {
  renderVisualSeparationPreview(root);
} else {
  renderEmptyGroupChat(root);
}
