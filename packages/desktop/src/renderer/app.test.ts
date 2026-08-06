import { describe, expect, it } from "vitest";
import * as importedApp from "./app.js";

type RendererUnderTest = {
  renderEmptyGroupChat?: (root: HTMLElement) => void;
  renderMessageTimeline?: (
    root: HTMLElement,
    messages: readonly unknown[],
    actorsById: ReadonlyMap<string, unknown>,
  ) => void;
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

describe("message timeline renderer", () => {
  it("renders people and agents as deliberately different message forms", () => {
    const root = document.createElement("main");
    const humanMessage = {
      id: "message-human-1",
      roomId: "room-product",
      authorId: "human-li",
      authorKind: "human",
      body: "我来确认权限边界。",
      sentAt: "2026-08-06T14:20:00.000Z",
    };
    const agentMessage = {
      id: "message-agent-security-1",
      roomId: "room-product",
      authorId: "agent-security",
      authorKind: "agent",
      body: "HR 与合同两类必须走私有化。",
      sentAt: "2026-08-06T14:33:00.000Z",
    };
    const actorsById = new Map<string, unknown>([
      [
        "human-li",
        { id: "human-li", kind: "human", displayName: "李乐", reachability: "online" },
      ],
      [
        "agent-security",
        {
          id: "agent-security",
          kind: "agent",
          displayName: "安全 agent",
          readiness: "ready",
          toolPermissions: ["knowledge-base"],
        },
      ],
    ]);

    expect(app.renderMessageTimeline).toBeTypeOf("function");
    app.renderMessageTimeline?.(root, [humanMessage, agentMessage], actorsById);

    const human = root.querySelector<HTMLElement>("[data-message-kind='human']");
    const agent = root.querySelector<HTMLElement>("[data-message-kind='agent']");

    expect(human?.querySelector(".message-bubble")).not.toBeNull();
    expect(human?.querySelector(".message-role-rail")).toBeNull();
    expect(human?.querySelector(".message-avatar--human")).not.toBeNull();
    expect(agent?.querySelector(".message-role-rail")).not.toBeNull();
    expect(agent?.querySelector(".message-role-label")?.textContent).toBe("安全 agent");
    expect(agent?.querySelector(".message-avatar--agent")).not.toBeNull();
  });

  it("uses the actor kind rather than a shared avatar treatment", () => {
    const root = document.createElement("main");
    const message = {
      id: "message-agent-1",
      roomId: "room-product",
      authorId: "agent-security",
      authorKind: "agent",
      body: "风险检查完成。",
      sentAt: "2026-08-06T14:34:00.000Z",
    };
    const actorsById = new Map<string, unknown>([
      [
        "agent-security",
        {
          id: "agent-security",
          kind: "agent",
          displayName: "安全 agent",
          readiness: "ready",
          toolPermissions: ["knowledge-base"],
        },
      ],
    ]);

    app.renderMessageTimeline?.(root, [message], actorsById);

    const rendered = root.querySelector<HTMLElement>("[data-message-kind='agent']");
    expect(rendered?.classList.contains("message--agent")).toBe(true);
    expect(rendered?.classList.contains("message--human")).toBe(false);
    expect(rendered?.querySelector(".message-bubble")).toBeNull();
  });

  it("does not turn an agent record into a human bubble when actor data is inconsistent", () => {
    const root = document.createElement("main");
    const message = {
      id: "message-agent-mismatch",
      roomId: "room-product",
      authorId: "agent-security",
      authorKind: "agent",
      body: "这条行为记录仍然是 agent 消息。",
      sentAt: "2026-08-06T14:35:00.000Z",
    };
    const actorsById = new Map<string, unknown>([
      [
        "agent-security",
        { id: "agent-security", kind: "human", displayName: "错误成员", reachability: "online" },
      ],
    ]);

    app.renderMessageTimeline?.(root, [message], actorsById);

    const rendered = root.querySelector<HTMLElement>("[data-message-kind='agent']");
    expect(rendered?.querySelector(".message-role-rail")).not.toBeNull();
    expect(rendered?.querySelector(".message-avatar--agent")).not.toBeNull();
    expect(rendered?.querySelector(".message-bubble")).toBeNull();
    expect(root.querySelector("[data-message-kind='human']")).toBeNull();
  });

  it("keeps the existing empty-group-chat fallback for an empty timeline", () => {
    const root = document.createElement("main");

    app.renderMessageTimeline?.(root, [], new Map());

    expect(root.querySelector("[data-testid='empty-group-chat']")).not.toBeNull();
    expect(root.textContent).toContain("还没有消息");
  });

  it("rejects a stale same-kind actor record whose id belongs to another member", () => {
    const root = document.createElement("main");
    const message = {
      id: "message-agent-stale-actor",
      roomId: "room-product",
      authorId: "agent-security",
      authorKind: "agent",
      body: "行为记录不能被错误成员冠名。",
      sentAt: "2026-08-06T14:36:00.000Z",
    };
    const actorsById = new Map<string, unknown>([
      [
        "agent-security",
        {
          id: "agent-stale",
          kind: "agent",
          displayName: "过期 Agent",
          readiness: "ready",
          toolPermissions: ["knowledge-base"],
        },
      ],
    ]);

    app.renderMessageTimeline?.(root, [message], actorsById);

    const rendered = root.querySelector<HTMLElement>("[data-message-kind='agent']");
    expect(rendered?.querySelector(".message-author")?.textContent).toBe("Agent");
    expect(rendered?.textContent).not.toContain("过期 Agent");
  });

  it("uses visible agent role titles for both labels and deterministic role colours", () => {
    const root = document.createElement("main");
    const messages = [
      {
        id: "message-agent-research",
        roomId: "room-product",
        authorId: "agent-a",
        authorKind: "agent" as const,
        body: "研究结论已归档。",
        sentAt: "2026-08-06T14:37:00.000Z",
      },
      {
        id: "message-agent-security",
        roomId: "room-product",
        authorId: "agent-f",
        authorKind: "agent" as const,
        body: "风险检查已完成。",
        sentAt: "2026-08-06T14:38:00.000Z",
      },
    ];
    const actorsById = new Map<string, unknown>([
      [
        "agent-a",
        {
          id: "agent-a",
          kind: "agent",
          displayName: "Research Agent",
          readiness: "ready",
          toolPermissions: ["search"],
        },
      ],
      [
        "agent-f",
        {
          id: "agent-f",
          kind: "agent",
          displayName: "Security Agent",
          readiness: "ready",
          toolPermissions: ["policy"],
        },
      ],
    ]);

    app.renderMessageTimeline?.(root, messages, actorsById);

    const rendered = root.querySelectorAll<HTMLElement>("[data-message-kind='agent']");
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.querySelector(".message-role-label")?.textContent).toBe("Research Agent");
    expect(rendered[1]?.querySelector(".message-role-label")?.textContent).toBe("Security Agent");
    expect(rendered[0]?.style.getPropertyValue("--message-role-colour")).not.toBe(
      rendered[1]?.style.getPropertyValue("--message-role-colour"),
    );
  });
});
