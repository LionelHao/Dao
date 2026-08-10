import {
  renderEmptyGroupChat,
  renderM2PrimitivesPreview,
  renderRoomJoinReview,
  renderVisualSeparationPreview,
} from "./app.js";

const root = document.querySelector<HTMLElement>("#app");

if (root === null) {
  throw new Error("Desktop renderer requires an #app root element.");
}

const reviewRoute = new URLSearchParams(window.location.search);

if (reviewRoute.has("m2-primitives")) {
  renderM2PrimitivesPreview(root);
} else if (reviewRoute.has("join-review")) {
  renderRoomJoinReview(root);
} else if (reviewRoute.has("visual-review")) {
  renderVisualSeparationPreview(root);
} else {
  renderEmptyGroupChat(root);
}
