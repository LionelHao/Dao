import { describe, expect, it } from "vitest";
import type {
  AgentActor,
  AgentConfigurationRequest,
  HumanInvitationRequest,
} from "@native-im/core";
import * as importedApp from "./app.js";

type RendererUnderTest = {
  renderEmptyGroupChat?: (root: HTMLElement) => void;
  renderMessageTimeline?: (
    root: HTMLElement,
    messages: readonly unknown[],
    actorsById: ReadonlyMap<string, unknown>,
  ) => void;
  renderVisualSeparationPreview?: (root: HTMLElement) => void;
  renderRoomJoinControls?: (
    root: HTMLElement,
    options: {
      readonly roomId: string;
      readonly agents: readonly AgentActor[];
      readonly onInviteHuman: (request: HumanInvitationRequest) => void;
      readonly onConfigureAgent: (request: AgentConfigurationRequest) => void;
    },
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
  it("renders a review fixture with both message forms and an overflow agent", () => {
    const root = document.createElement("main");

    expect(app.renderVisualSeparationPreview).toBeTypeOf("function");
    app.renderVisualSeparationPreview?.(root);

    expect(root.dataset.testid).toBe("visual-separation-preview");
    expect(root.querySelector("[data-message-kind='human'] .message-bubble")).not.toBeNull();
    expect(root.querySelector("[data-message-kind='agent'] .message-role-rail")).not.toBeNull();
    const agents = Array.from(root.querySelectorAll<HTMLElement>("[data-message-kind='agent']"));

    expect(agents).toHaveLength(6);
    expect(agents[4]?.querySelector(".message-avatar--agent-overflow")).toBeNull();
    expect(agents[5]?.querySelector(".message-avatar--agent-overflow")).not.toBeNull();
  });

  it("renders the same text as different DOM forms for a human and an agent", () => {
    const root = document.createElement("main");
    const sharedBody = "请确认这项协作约定。";
    const messages = [
      {
        id: "message-human-shared-body",
        roomId: "room-product",
        authorId: "human-li",
        authorKind: "human" as const,
        body: sharedBody,
        sentAt: "2026-08-06T15:00:00.000Z",
      },
      {
        id: "message-agent-shared-body",
        roomId: "room-product",
        authorId: "agent-security",
        authorKind: "agent" as const,
        body: sharedBody,
        sentAt: "2026-08-06T15:01:00.000Z",
      },
    ];
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
          displayName: "安全 Agent",
          readiness: "ready",
          toolPermissions: ["knowledge-base"],
        },
      ],
    ]);

    app.renderMessageTimeline?.(root, messages, actorsById);

    const human = root.querySelector<HTMLElement>("[data-message-kind='human']");
    const agent = root.querySelector<HTMLElement>("[data-message-kind='agent']");

    expect(human?.textContent).toContain(sharedBody);
    expect(agent?.textContent).toContain(sharedBody);
    expect(human?.classList.contains("message--human")).toBe(true);
    expect(agent?.classList.contains("message--agent")).toBe(true);
    expect(human?.querySelector(".message-bubble")).not.toBeNull();
    expect(agent?.querySelector(".message-role-rail")).not.toBeNull();
  });

  it("uses five role-colour slots before adding an overflow identity pattern", () => {
    const root = document.createElement("main");
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `message-agent-${index + 1}`,
      roomId: "room-product",
      authorId: `agent-${index + 1}`,
      authorKind: "agent" as const,
      body: "视觉编码检查。",
      sentAt: `2026-08-06T15:0${index}:00.000Z`,
    }));
    const actorsById = new Map<string, unknown>(
      Array.from({ length: 6 }, (_, index) => [
        `agent-${index + 1}`,
        {
          id: `agent-${index + 1}`,
          kind: "agent",
          displayName: `Role ${index + 1} Agent`,
          readiness: "ready",
          toolPermissions: ["knowledge-base"],
        },
      ]),
    );

    app.renderMessageTimeline?.(root, messages, actorsById);

    const agents = Array.from(root.querySelectorAll<HTMLElement>("[data-message-kind='agent']"));
    const paletteSlots = new Set(agents.map((agent) => agent.dataset.agentPaletteSlot));

    expect(agents).toHaveLength(6);
    expect(paletteSlots.size).toBe(5);
    expect(agents[5]?.dataset.agentIdentityFallback).toBe("pattern-and-initial");
    expect(agents[5]?.querySelector(".message-avatar--agent-overflow")).not.toBeNull();
  });

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
    expect(rendered[0]?.querySelector(".message-author")?.textContent).toBe("Agent");
    expect(rendered[0]?.querySelector(".message-role-label")?.textContent).toBe("Research Agent");
    expect(rendered[1]?.querySelector(".message-role-label")?.textContent).toBe("Security Agent");
    expect(rendered[0]?.style.getPropertyValue("--message-role-colour")).not.toBe(
      rendered[1]?.style.getPropertyValue("--message-role-colour"),
    );
  });
});

const joinControlAgents: readonly AgentActor[] = [
  {
    id: "agent-research",
    kind: "agent",
    displayName: "研究 Agent",
    readiness: "ready",
    toolPermissions: ["search", "summarize"],
  },
  {
    id: "agent-ops",
    kind: "agent",
    displayName: "运维 Agent",
    readiness: "busy",
    toolPermissions: ["deploy"],
  },
];

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("room join controls", () => {
  it("renders adjacent and accessible human invitation and agent configuration modules", () => {
    const root = document.createElement("main");

    app.renderRoomJoinControls?.(root, {
      roomId: "room-product",
      agents: joinControlAgents,
      onInviteHuman: () => undefined,
      onConfigureAgent: () => undefined,
    });

    expect(app.renderRoomJoinControls).toBeTypeOf("function");
    const human = root.querySelector<HTMLElement>("[data-join-kind='human-invitation']");
    const agent = root.querySelector<HTMLElement>("[data-join-kind='agent-configuration']");

    expect(human).not.toBeNull();
    expect(agent).not.toBeNull();
    expect(human?.parentElement).toBe(agent?.parentElement);
    expect(human?.nextElementSibling).toBe(agent);
    expect(human?.textContent).toContain("接受或拒绝");
    expect(human?.textContent).toContain("等待对方接受");
    expect(agent?.textContent).toContain("立即生效");
    expect(agent?.textContent).toContain("无需接受");
    expect(agent?.textContent).toContain("参与度");
    expect(agent?.textContent).toContain("工具权限");

    const actorInput = human?.querySelector<HTMLInputElement>("input[name='inviteeActorId']");
    const actorLabel = actorInput === null ? null : human?.querySelector(`label[for='${actorInput.id}']`);
    const agentSelect = agent?.querySelector<HTMLSelectElement>("select[name='agentId']");
    const participationSelect = agent?.querySelector<HTMLSelectElement>(
      "select[name='participation']",
    );
    const permissionLegend = agent?.querySelector("fieldset legend");

    expect(actorInput).not.toBeNull();
    expect(actorLabel?.textContent).toContain("成员 ID");
    expect(human?.querySelector("button[type='submit']")?.textContent).toContain("邀请真人");
    expect(human?.querySelector("[role='status'][aria-live='polite']")).not.toBeNull();
    expect(agentSelect).not.toBeNull();
    expect(agent?.querySelector(`label[for='${agentSelect?.id}']`)?.textContent).toContain("Agent");
    expect(participationSelect).not.toBeNull();
    expect(agent?.querySelector(`label[for='${participationSelect?.id}']`)?.textContent).toContain(
      "参与度",
    );
    expect(permissionLegend?.textContent).toContain("工具权限");
    expect(agent?.querySelector("button[type='submit']")?.textContent).toContain("配置 Agent");
    expect(agent?.querySelector("[role='status'][aria-live='polite']")).not.toBeNull();
  });

  it("validates a trimmed human actor id and emits only a human invitation payload", () => {
    const root = document.createElement("main");
    const humanRequests: HumanInvitationRequest[] = [];
    const agentRequests: AgentConfigurationRequest[] = [];

    app.renderRoomJoinControls?.(root, {
      roomId: "room-product",
      agents: joinControlAgents,
      onInviteHuman: (request) => humanRequests.push(request),
      onConfigureAgent: (request) => agentRequests.push(request),
    });

    const form = root.querySelector<HTMLFormElement>(
      "[data-join-kind='human-invitation'] form",
    );
    const actorInput = form?.elements.namedItem("inviteeActorId") as HTMLInputElement | null;
    const status = root.querySelector<HTMLElement>(
      "[data-join-kind='human-invitation'] [role='status']",
    );

    expect(form).not.toBeNull();
    expect(actorInput).not.toBeNull();
    actorInput!.value = "   ";
    submit(form!);
    expect(humanRequests).toEqual([]);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("成员 ID");

    actorInput!.value = "  human-lin  ";
    submit(form!);

    expect(humanRequests).toEqual([
      {
        kind: "human-invitation",
        roomId: "room-product",
        inviteeActorId: "human-lin",
      },
    ]);
    expect(agentRequests).toEqual([]);
    expect(Object.keys(humanRequests[0] ?? {}).sort()).toEqual([
      "inviteeActorId",
      "kind",
      "roomId",
    ]);
    expect(status?.textContent).toContain("等待对方接受");
  });

  it("requires an agent, participation, and declared permission before emitting only agent configuration", () => {
    const root = document.createElement("main");
    const humanRequests: HumanInvitationRequest[] = [];
    const agentRequests: AgentConfigurationRequest[] = [];

    app.renderRoomJoinControls?.(root, {
      roomId: "room-product",
      agents: joinControlAgents,
      onInviteHuman: (request) => humanRequests.push(request),
      onConfigureAgent: (request) => agentRequests.push(request),
    });

    const form = root.querySelector<HTMLFormElement>(
      "[data-join-kind='agent-configuration'] form",
    );
    const agentSelect = form?.elements.namedItem("agentId") as HTMLSelectElement | null;
    const participation = form?.elements.namedItem("participation") as HTMLSelectElement | null;
    const status = root.querySelector<HTMLElement>(
      "[data-join-kind='agent-configuration'] [role='status']",
    );

    expect(form).not.toBeNull();
    submit(form!);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("Agent");

    agentSelect!.value = "agent-research";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    participation!.value = "on-mention";
    submit(form!);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("工具权限");

    const searchPermission = form?.querySelector<HTMLInputElement>(
      "input[name='toolPermissions'][value='search']",
    );
    expect(searchPermission).not.toBeNull();
    searchPermission!.checked = true;
    submit(form!);

    expect(agentRequests).toEqual([
      {
        kind: "agent-configuration",
        roomId: "room-product",
        agentId: "agent-research",
        participation: "on-mention",
        toolPermissions: ["search"],
      },
    ]);
    expect(humanRequests).toEqual([]);
    expect(Object.keys(agentRequests[0] ?? {}).sort()).toEqual([
      "agentId",
      "kind",
      "participation",
      "roomId",
      "toolPermissions",
    ]);
    expect(status?.textContent).toContain("立即生效");
  });

  it("deduplicates agent options and permissions, then resets permissions when the agent changes", () => {
    const root = document.createElement("main");
    const agents = [
      {
        ...joinControlAgents[0]!,
        toolPermissions: ["search", "search", "summarize"],
      },
      { ...joinControlAgents[0]!, displayName: "重复 Agent", toolPermissions: ["tampered"] },
      joinControlAgents[1]!,
    ];

    app.renderRoomJoinControls?.(root, {
      roomId: "room-product",
      agents,
      onInviteHuman: () => undefined,
      onConfigureAgent: () => undefined,
    });

    const form = root.querySelector<HTMLFormElement>(
      "[data-join-kind='agent-configuration'] form",
    );
    const select = form?.elements.namedItem("agentId") as HTMLSelectElement | null;

    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "agent-research",
      "agent-ops",
    ]);
    select!.value = "agent-research";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(
      Array.from(form?.querySelectorAll<HTMLInputElement>("input[name='toolPermissions']") ?? []).map(
        (input) => input.value,
      ),
    ).toEqual(["search", "summarize"]);

    const searchPermission = form?.querySelector<HTMLInputElement>(
      "input[name='toolPermissions'][value='search']",
    );
    searchPermission!.checked = true;
    select!.value = "agent-ops";
    select!.dispatchEvent(new Event("change", { bubbles: true }));

    const permissionsAfterChange = Array.from(
      form?.querySelectorAll<HTMLInputElement>("input[name='toolPermissions']") ?? [],
    );
    expect(permissionsAfterChange.map((input) => input.value)).toEqual(["deploy"]);
    expect(permissionsAfterChange.every((input) => !input.checked)).toBe(true);
  });

  it("disables invalid agent data and rejects tampered values without calling either callback", () => {
    const root = document.createElement("main");
    const humanRequests: HumanInvitationRequest[] = [];
    const agentRequests: AgentConfigurationRequest[] = [];
    const invalidAgents = [
      null,
      { id: "", kind: "agent", displayName: "Broken", readiness: "ready", toolPermissions: [] },
      { id: "agent-broken", kind: "agent", displayName: "", readiness: "ready" },
      {
        id: "agent-wrong-readiness",
        kind: "agent",
        displayName: "错误状态 Agent",
        readiness: "online",
        toolPermissions: [],
      },
    ] as unknown as readonly AgentActor[];

    expect(() =>
      app.renderRoomJoinControls?.(root, {
        roomId: "room-product",
        agents: invalidAgents,
        onInviteHuman: (request) => humanRequests.push(request),
        onConfigureAgent: (request) => agentRequests.push(request),
      }),
    ).not.toThrow();

    const form = root.querySelector<HTMLFormElement>(
      "[data-join-kind='agent-configuration'] form",
    );
    const agentSelect = form?.elements.namedItem("agentId") as HTMLSelectElement | null;
    const submitButton = form?.querySelector<HTMLButtonElement>("button[type='submit']");

    expect(agentSelect?.disabled).toBe(true);
    expect(submitButton?.disabled).toBe(true);
    expect(root.textContent).toContain("没有可配置的 Agent");
    expect(() => submit(form!)).not.toThrow();
    expect(humanRequests).toEqual([]);
    expect(agentRequests).toEqual([]);

    const validRoot = document.createElement("main");
    app.renderRoomJoinControls?.(validRoot, {
      roomId: "room-product",
      agents: joinControlAgents,
      onInviteHuman: (request) => humanRequests.push(request),
      onConfigureAgent: (request) => agentRequests.push(request),
    });
    const validForm = validRoot.querySelector<HTMLFormElement>(
      "[data-join-kind='agent-configuration'] form",
    );
    const validAgentSelect = validForm?.elements.namedItem("agentId") as HTMLSelectElement | null;
    const validParticipation = validForm?.elements.namedItem(
      "participation",
    ) as HTMLSelectElement | null;
    validAgentSelect!.append(new Option("伪造 Agent", "agent-tampered"));
    validAgentSelect!.value = "agent-tampered";
    validParticipation!.value = "active";

    expect(() => submit(validForm!)).not.toThrow();
    expect(humanRequests).toEqual([]);
    expect(agentRequests).toEqual([]);
    expect(
      validRoot.querySelector("[data-join-kind='agent-configuration'] [role='status']")
        ?.textContent,
    ).toContain("有效的 Agent");
  });

  it("keeps empty and blank-only tool agents visible but unavailable", () => {
    const root = document.createElement("main");
    const requests: AgentConfigurationRequest[] = [];
    const noToolAgent: AgentActor = {
      id: "agent-observer",
      kind: "agent",
      displayName: "观察 Agent",
      readiness: "paused",
      toolPermissions: [],
    };
    const blankToolAgent: AgentActor = {
      id: "agent-blank-tools",
      kind: "agent",
      displayName: "空白权限 Agent",
      readiness: "ready",
      toolPermissions: [" ", "   "],
    };

    app.renderRoomJoinControls?.(root, {
      roomId: "room-product",
      agents: [noToolAgent, blankToolAgent],
      onInviteHuman: () => undefined,
      onConfigureAgent: (request) => requests.push(request),
    });

    const form = root.querySelector<HTMLFormElement>(
      "[data-join-kind='agent-configuration'] form",
    );
    const agentSelect = form?.elements.namedItem("agentId") as HTMLSelectElement | null;
    const participation = form?.elements.namedItem("participation") as HTMLSelectElement | null;
    const submitButton = form?.querySelector<HTMLButtonElement>("button[type='submit']");
    const options = Array.from(agentSelect?.options ?? []);

    expect(options.map((option) => option.value)).toEqual([
      "",
      "agent-observer",
      "agent-blank-tools",
    ]);
    expect(options.slice(1).every((option) => option.disabled)).toBe(true);
    expect(options[1]?.textContent).toContain("未声明工具");
    expect(options[2]?.textContent).toContain("未声明工具");
    expect(participation?.disabled).toBe(true);
    expect(submitButton?.disabled).toBe(true);
    expect(root.querySelector("[data-join-kind='agent-configuration'] [role='status']")?.textContent)
      .toContain("均未声明工具权限");

    for (const agentId of ["agent-observer", "agent-blank-tools"]) {
      agentSelect!.value = agentId;
      agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      participation!.disabled = false;
      participation!.value = "silent";
      submit(form!);

      expect(requests).toEqual([]);
      expect(
        root.querySelector("[data-join-kind='agent-configuration'] [role='status']")?.textContent,
      ).toContain("没有已声明的工具权限");
    }
  });

  it("resets grants and blocks a tampered switch from a configurable agent to a no-tool agent", () => {
    const root = document.createElement("main");
    const requests: AgentConfigurationRequest[] = [];
    const noToolAgent: AgentActor = {
      id: "agent-observer",
      kind: "agent",
      displayName: "观察 Agent",
      readiness: "paused",
      toolPermissions: [],
    };

    app.renderRoomJoinControls?.(root, {
      roomId: "room-product",
      agents: [joinControlAgents[0]!, noToolAgent],
      onInviteHuman: () => undefined,
      onConfigureAgent: (request) => requests.push(request),
    });

    const form = root.querySelector<HTMLFormElement>(
      "[data-join-kind='agent-configuration'] form",
    );
    const agentSelect = form?.elements.namedItem("agentId") as HTMLSelectElement | null;
    const participation = form?.elements.namedItem("participation") as HTMLSelectElement | null;
    const submitButton = form?.querySelector<HTMLButtonElement>("button[type='submit']");
    const noToolOption = Array.from(agentSelect?.options ?? []).find(
      (option) => option.value === "agent-observer",
    );

    expect(noToolOption?.disabled).toBe(true);
    agentSelect!.value = "agent-research";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    participation!.value = "active";
    const searchPermission = form?.querySelector<HTMLInputElement>(
      "input[name='toolPermissions'][value='search']",
    );
    searchPermission!.checked = true;

    agentSelect!.value = "agent-observer";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(form?.querySelectorAll("input[name='toolPermissions']")).toHaveLength(0);
    expect(form?.querySelector("fieldset")?.textContent).toContain("没有已声明的工具权限");
    expect(submitButton?.disabled).toBe(true);
    submit(form!);

    expect(requests).toEqual([]);
    expect(root.querySelector("[data-join-kind='agent-configuration'] [role='status']")?.textContent)
      .toContain("没有已声明的工具权限");

    agentSelect!.value = "agent-research";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submitButton?.disabled).toBe(false);
    expect(
      Array.from(form?.querySelectorAll<HTMLInputElement>("input[name='toolPermissions']") ?? [])
        .every((input) => !input.checked),
    ).toBe(true);

    submit(form!);
    expect(requests).toEqual([]);
  });
});
