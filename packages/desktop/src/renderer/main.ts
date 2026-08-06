import { renderEmptyGroupChat } from "./app.js";

const root = document.querySelector<HTMLElement>("#app");

if (root === null) {
  throw new Error("Desktop renderer requires an #app root element.");
}

renderEmptyGroupChat(root);
