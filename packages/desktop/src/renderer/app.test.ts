import { describe, expect, it } from "vitest";
import * as importedApp from "./app.js";

type RendererUnderTest = {
  renderEmptyGroupChat?: (root: HTMLElement) => void;
};

const app = importedApp as unknown as RendererUnderTest;

describe("empty group chat renderer", () => {
  it("renders a visible empty collaboration room without pretending an agent is a human", () => {
    const root = document.createElement("main");

    expect(app.renderEmptyGroupChat).toBeTypeOf("function");
    app.renderEmptyGroupChat?.(root);

    expect(root.querySelector("[data-testid='empty-group-chat']")).not.toBeNull();
    expect(root.textContent).toContain("还没有消息");
    expect(root.textContent).toContain("邀请真人或编制 agent 后开始协作");
  });
});

