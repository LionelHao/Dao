import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  AgentActor,
  AgentConfigurationRequest,
  AgentExecution,
  AgentJudgement,
  CalibrationSignal,
  HumanReadReceipt,
  HumanInvitationRequest,
  OpenItem,
  SocialReaction,
} from "@native-im/core";
import * as importedApp from "./app.js";

interface RestoredPrimitivePreviewRecords {
  readonly humanReads: readonly HumanReadReceipt[];
  readonly agentJudgements: readonly AgentJudgement[];
  readonly openItems: readonly OpenItem[];
  readonly agentExecutions: readonly AgentExecution[];
  readonly socialReactions: readonly SocialReaction[];
  readonly calibrations: readonly CalibrationSignal[];
}

type RendererUnderTest = {
  renderEmptyGroupChat?: (root: HTMLElement) => void;
  renderMessageTimeline?: (
    root: HTMLElement,
    messages: readonly unknown[],
    actorsById: ReadonlyMap<string, unknown>,
  ) => void;
  renderVisualSeparationPreview?: (root: HTMLElement) => void;
  renderM2PrimitivesPreview?: (
    root: HTMLElement,
    restored?: RestoredPrimitivePreviewRecords,
  ) => void;
  renderRoomJoinReview?: (root: HTMLElement) => void;
  renderRoomJoinControls?: (
    root: HTMLElement,
    options: {
      readonly roomId: string;
      readonly agents: readonly AgentActor[];
      readonly onInviteHuman: (request: HumanInvitationRequest) => void;
      readonly onConfigureAgent: (request: AgentConfigurationRequest) => void;
    },
  ) => void;
  renderAgentExecutionLifecycle?: (
    root: HTMLElement,
    options: {
      readonly execution: AgentExecution;
      readonly agentLabel: string;
      readonly confirmation?: {
        readonly toolId: string;
        readonly target: string;
        readonly impact: string;
      };
      readonly onInterrupt?: (executionId: string) => void;
      readonly onRetry?: (executionId: string) => void;
      readonly onConfirm?: (executionId: string) => void;
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

describe("verified collaboration primitive renderer", () => {
  it("renders authoritative execution labels and actions without human typing semantics", () => {
    const root = document.createElement("main");
    const calls: string[] = [];
    const base: AgentExecution = {
      id: "execution-live", roomId: "preview-room", sourceMessageId: "preview-human-mention",
      requesterId: "human-li", agentId: "agent-data", status: "running",
      actionCategory: "model_generation", providerId: "openai.responses", modelId: "gpt-5",
      currentAttemptSeq: 2, retryCycle: 1, retryOrdinal: 1,
      queuedAt: "2026-08-12T00:00:00.000Z",
      startedAt: "2026-08-12T00:00:01.000Z", recoveryCursor: 3,
      updatedAt: "2026-08-12T00:00:02.000Z",
    };
    const render = (execution: AgentExecution, confirmation?: {
      readonly toolId: string; readonly target: string; readonly impact: string;
    }) => app.renderAgentExecutionLifecycle?.(root, {
      execution, agentLabel: "数据 Agent", confirmation,
      onInterrupt: () => calls.push("interrupt"),
      onRetry: () => calls.push("retry"),
      onConfirm: () => calls.push("confirm"),
    });

    expect(app.renderAgentExecutionLifecycle).toBeTypeOf("function");
    const queued = structuredClone(base) as { status: AgentExecution["status"]; startedAt?: string };
    queued.status = "queued";
    Reflect.deleteProperty(queued, "startedAt");
    render(queued as AgentExecution);
    expect(root.textContent).toContain("排队中");
    render(base);
    expect(root.textContent).toContain("正在生成");
    expect(root.textContent).toContain("第 2 次尝试");
    root.querySelector<HTMLButtonElement>("[data-action='interrupt']")?.click();

    render({ ...base, actionCategory: "tool_call", toolDispatchPhase: "dispatched", currentToolId: "search.web" });
    expect(root.textContent).toContain("正在调用 search.web");

    render({ ...base, actionCategory: "waiting_upstream" }, {
      toolId: "sandbox-file.write", target: "note.txt", impact: "替换文件",
    });
    expect(root.textContent).toContain("等待上游");
    expect(root.textContent).toContain("note.txt");
    root.querySelector<HTMLButtonElement>("[data-action='confirm']")?.click();

    render({
      ...base, status: "failed", actionCategory: "model_generation",
      finishedAt: "2026-08-12T00:00:02.000Z", terminalErrorCode: "provider_failure",
    });
    expect(root.textContent).toContain("已失败");
    expect(root.textContent).toContain("provider_failure");
    root.querySelector<HTMLButtonElement>("[data-action='retry']")?.click();
    render({
      ...base, status: "completed", actionCategory: "model_generation",
      finishedAt: "2026-08-12T00:00:02.000Z", resultMessageId: "message-result",
    });
    expect(root.textContent).toContain("已完成");
    render({
      ...base, status: "cancelled", actionCategory: "model_generation",
      finishedAt: "2026-08-12T00:00:02.000Z", cancellationReason: "requested_by_requester",
    });
    expect(root.textContent).toContain("已取消");
    expect(calls).toEqual(["interrupt", "confirm", "retry"]);
    expect(root.querySelector(".typing")).toBeNull();
    expect(root.querySelector("[data-typing-dots]")).toBeNull();
    expect(root.querySelector("[data-action='read']")).toBeNull();
    expect(root.querySelector("[data-action='request']")).toBeNull();
  });
  it("rejects malformed or unrelated restored records before mutating the DOM", () => {
    const empty = (): RestoredPrimitivePreviewRecords => ({
      humanReads: [], agentJudgements: [], openItems: [], agentExecutions: [],
      socialReactions: [], calibrations: [],
    });
    const read: HumanReadReceipt = {
      id: "closed-read", messageId: "preview-agent-data", readerId: "human-a",
      readAt: "2026-08-12T00:00:00.000Z",
    };
    const judgement: AgentJudgement = {
      id: "closed-judgement", messageId: "preview-human-mention", agentId: "agent-a",
      outcome: "will_respond", reason: "closed", decidedAt: "2026-08-12T00:00:00.000Z",
    };
    const wrongEnum = structuredClone(judgement);
    Reflect.set(wrongEnum, "outcome", "invented");
    const extraEnvelope = empty();
    Reflect.set(extraEnvelope, "extra", []);
    const missingEnvelope = empty();
    Reflect.deleteProperty(missingEnvelope, "calibrations");
    const nonArrayEnvelope = empty();
    Reflect.set(nonArrayEnvelope, "humanReads", {});
    const cases: RestoredPrimitivePreviewRecords[] = [
      extraEnvelope, missingEnvelope, nonArrayEnvelope,
      { ...empty(), humanReads: [Object.assign(structuredClone(read), { extra: true })] },
      { ...empty(), agentJudgements: [wrongEnum] },
      { ...empty(), humanReads: [{ ...read, messageId: "other-message" }] },
      { ...empty(), openItems: [{
        id: "wrong-room", roomId: "other-room", sourceMessageId: "preview-agent-data",
        requesterId: "human-a", ownerId: "human-a", content: "closed",
        status: "pending_response", createdAt: "2026-08-12T00:00:00.000Z",
        transferChain: [],
      }] },
      { ...empty(), humanReads: [read], agentJudgements: [{ ...judgement, id: read.id }] },
    ];

    for (const restored of cases) {
      const root = document.createElement("main");
      root.innerHTML = "<p>unchanged</p>";
      expect(() => app.renderM2PrimitivesPreview?.(root, restored)).toThrow(TypeError);
      expect(root.innerHTML).toBe("<p>unchanged</p>");
    }
  });

  it("keeps restored human, Agent, request, execution, social, and calibration facts visibly separate", () => {
    const root = document.createElement("main");
    const restored: RestoredPrimitivePreviewRecords = {
      humanReads: [{
        id: "read-restored",
        messageId: "preview-agent-data",
        readerId: "恢复用户甲",
        readAt: "2026-08-12T13:00:00.000Z",
      }],
      agentJudgements: [{
        id: "judgement-restored",
        messageId: "preview-human-mention",
        agentId: "恢复 Agent",
        outcome: "will_respond",
        reason: "恢复后仍会回应",
        decidedAt: "2026-08-12T13:00:01.000Z",
      }],
      openItems: [{
        id: "open-restored",
        roomId: "preview-room",
        sourceMessageId: "preview-agent-data",
        requesterId: "恢复请求者",
        ownerId: "恢复负责人",
        content: "恢复后的待答问题",
        status: "pending_response",
        createdAt: "2026-08-12T13:00:02.000Z",
        transferChain: [],
      }],
      agentExecutions: [{
        id: "execution-restored",
        roomId: "preview-room",
        sourceMessageId: "preview-human-mention",
        requesterId: "恢复请求者",
        agentId: "恢复 Agent",
        status: "running",
        actionCategory: "tool_call",
        toolDispatchPhase: "dispatched",
        currentToolId: "restore.inspect",
        currentAttemptSeq: 1,
        retryCycle: 1,
        retryOrdinal: 1,
        providerId: "restore-direct-tool",
        modelId: "no-model",
        recoveryCursor: 0,
        queuedAt: "2026-08-12T13:00:03.000Z",
        startedAt: "2026-08-12T13:00:03.000Z",
        updatedAt: "2026-08-12T13:00:03.000Z",
      }],
      socialReactions: [{
        id: "social-restored",
        sourceMessageId: "preview-human-mention",
        actorId: "恢复用户甲",
        emoji: "🎉",
        createdAt: "2026-08-12T13:00:04.000Z",
      }],
      calibrations: [{
        id: "calibration-restored",
        sourceMessageId: "preview-agent-data",
        actorId: "恢复用户甲",
        agentId: "恢复 Agent",
        emoji: "👍",
        createdAt: "2026-08-12T13:00:05.000Z",
      }],
    };

    app.renderM2PrimitivesPreview?.(root, restored);

    const humanRead = root.querySelector(".human-read-receipt");
    const agentJudgement = root.querySelector(".agent-judgement");
    const openItem = root.querySelector(".open-item");
    const agentExecution = root.querySelector(".agent-invocation");
    const social = root.querySelector(".reaction--social");
    const calibration = root.querySelector(".reaction--calibration");

    expect(humanRead?.textContent).toContain("恢复用户甲");
    expect(humanRead?.textContent).toContain("已读");
    expect(agentJudgement?.textContent).toContain("恢复后仍会回应");
    expect(agentJudgement?.textContent).toContain("已判定");
    expect(openItem?.textContent).toContain("恢复后的待答问题");
    expect(openItem?.textContent).toContain("待答项");
    expect(agentExecution?.textContent).toContain("恢复 Agent 正在调用 restore.inspect");
    expect(agentExecution?.textContent).toContain("Agent 执行");
    expect(social?.textContent).toContain("🎉 纯社交");
    expect(calibration?.textContent).toContain("👍 校准：影响后续发言判定");
    expect(humanRead?.getAttribute("data-receipt-kind")).toBe("human-read");
    expect(agentJudgement?.getAttribute("data-receipt-kind")).toBe("agent-judgement");
    expect(openItem?.getAttribute("data-open-item-status")).toBe("pending_response");
    expect(agentExecution?.getAttribute("data-agent-invocation")).toBe("恢复 Agent");
    expect(agentExecution?.getAttribute("data-execution-status")).toBe("running");
    expect(social?.getAttribute("data-reaction-kind")).toBe("social");
    expect(calibration?.getAttribute("data-reaction-kind")).toBe("calibration");
    expect(humanRead?.classList.contains("agent-judgement")).toBe(false);
    expect(openItem?.classList.contains("agent-invocation")).toBe(false);
    expect(social?.classList.contains("reaction--calibration")).toBe(false);
    expect(humanRead?.closest("article")?.getAttribute("data-message-id"))
      .toBe("preview-agent-data");
    expect(agentJudgement?.closest("article")?.getAttribute("data-message-id"))
      .toBe("preview-human-mention");
  });

  it("T-0012 separates human reads from explainable agent judgements", () => {
    const root = document.createElement("main");

    expect(app.renderM2PrimitivesPreview).toBeTypeOf("function");
    app.renderM2PrimitivesPreview?.(root);

    const humanRead = root.querySelector("[data-receipt-kind='human-read']");
    const judgedContent = root.querySelector<HTMLElement>(
      "[data-message-id='preview-human-mention'] .message-content",
    );
    const judgements = judgedContent?.querySelectorAll(".agent-judgement");
    expect(humanRead?.classList.contains("human-read-receipt")).toBe(true);
    expect(humanRead?.textContent).toContain("周安全、陈研发");
    expect(judgements).toHaveLength(3);
    expect(judgements?.[0]?.textContent).toContain("未命中我的领域");
    expect(judgements?.[2]?.textContent).toContain("同话题冷却期内，还剩 7 分钟");
    expect(root.querySelectorAll("[data-message-kind='agent'] > .agent-judgement")).toHaveLength(0);
  });

  it("T-0013 distinguishes request and invocation mentions and exposes interruption", () => {
    const root = document.createElement("main");

    app.renderM2PrimitivesPreview?.(root);

    const humanMention = root.querySelector(".mention--human");
    const agentMention = root.querySelector(".mention--agent");
    const interrupt = root.querySelector<HTMLButtonElement>("[data-testid='interrupt-agent-execution']");
    expect(humanMention?.classList.contains("mention--agent")).toBe(false);
    expect(agentMention?.classList.contains("mention--human")).toBe(false);
    expect(root.querySelector("[data-open-item-status='transferred']")?.textContent).toContain("周安全 → 陈研发");
    expect(root.textContent).toContain("@all 只调用 Agent");
    expect(root.textContent).toContain("@here 仅群主可用");
    expect(root.querySelector("[data-agent-invocation] [data-action='reject']")).toBeNull();

    interrupt?.click();

    expect(root.querySelector("[data-agent-invocation]")?.getAttribute("data-execution-status")).toBe("cancelled");
    expect(root.querySelector("[data-member-id='agent-data']")?.textContent).toBe("可用");
  });

  it("T-0014 exposes human mutation controls, append-only correction, and separate calibration", () => {
    const root = document.createElement("main");

    app.renderM2PrimitivesPreview?.(root);

    expect(root.querySelector("[data-message-kind='human'] [data-action='edit']")).not.toBeNull();
    expect(root.querySelector("[data-message-kind='human'] [data-action='recall']")).not.toBeNull();
    expect(root.querySelector("[data-message-kind='agent'] [data-action='edit']")).toBeNull();
    expect(root.querySelector("[data-message-kind='agent'] [data-action='recall']")).toBeNull();
    expect(root.querySelector("[data-correction-for='preview-agent-data']")?.textContent)
      .toContain("原消息保留不变，更正追加在后");
    expect(root.querySelector("[data-reaction-kind='social']")?.textContent).toContain("纯社交");
    expect(root.querySelector("[data-reaction-kind='calibration']")?.textContent).toContain("校准");
  });
});

describe("renderer landmark labels", () => {
  it("labels the join review root for adding room participants", () => {
    const root = document.createElement("main");

    root.setAttribute("aria-label", "空群聊");
    expect(app.renderRoomJoinReview).toBeTypeOf("function");
    app.renderRoomJoinReview?.(root);

    expect(root.getAttribute("aria-label")).toBe("添加房间参与者");
  });

  it("restores the empty-room root label after rendering another view", () => {
    const root = document.createElement("main");

    root.setAttribute("aria-label", "添加房间参与者");
    app.renderEmptyGroupChat?.(root);

    expect(root.getAttribute("aria-label")).toBe("空群聊");
  });

  it("restores the visual review label when reusing the same root", () => {
    const root = document.createElement("main");

    root.setAttribute("aria-label", "添加房间参与者");
    app.renderVisualSeparationPreview?.(root);

    expect(root.getAttribute("aria-label")).toBe("人和 agent 的视觉分离预览");
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

function relativeLuminance(hexColour: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hexColour.slice(start, start + 2), 16));
  const linearChannels = channels.map((channel) => {
    const normalised = channel / 255;

    return normalised <= 0.04045
      ? normalised / 12.92
      : ((normalised + 0.055) / 1.055) ** 2.4;
  });

  return (
    0.2126 * (linearChannels[0] ?? 0) +
    0.7152 * (linearChannels[1] ?? 0) +
    0.0722 * (linearChannels[2] ?? 0)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

describe("join control visual accessibility tokens", () => {
  it("uses AA dark status colours and a three-to-one control boundary", () => {
    const styles = readFileSync("packages/desktop/src/renderer/styles.css", "utf8");
    const darkStatusBackground = "#202c40";
    const controlBorder = "#64748b";

    expect(contrastRatio("#6ce9a6", darkStatusBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#fda29b", darkStatusBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#fec84b", darkStatusBackground)).toBeGreaterThanOrEqual(4.5);
    for (const adjacentSurface of ["#ffffff", "#f5f8ff", "#111827", "#162945", "#182235"]) {
      expect(contrastRatio(controlBorder, adjacentSurface)).toBeGreaterThanOrEqual(3);
    }

    expect(styles).toContain("--join-control-border: #64748b;");
    expect(styles).toContain("--semantic-success: #6ce9a6;");
    expect(styles).toContain("--semantic-warning: #fec84b;");
    expect(styles).toContain("--semantic-danger: #fda29b;");
    expect(styles).toContain("color-scheme: light;");
    expect(styles).toContain("color-scheme: dark;");
    expect(styles.match(/border: 1px solid var\(--join-control-border\);/g)).toHaveLength(3);
  });
});

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

  it("assigns unique persistent status ids across multiple control instances", () => {
    const roots = [document.createElement("main"), document.createElement("main")];

    for (const root of roots) {
      app.renderRoomJoinControls?.(root, {
        roomId: "room-product",
        agents: joinControlAgents,
        onInviteHuman: () => undefined,
        onConfigureAgent: () => undefined,
      });
    }

    const statuses = roots.flatMap((root) =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-join-kind] [role='status']")),
    );
    const statusIds = statuses.map((status) => status.id);

    expect(statuses).toHaveLength(4);
    expect(statusIds.every((id) => id.length > 0)).toBe(true);
    expect(new Set(statusIds).size).toBe(statusIds.length);
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
    expect(status?.id).not.toBe("");
    expect(actorInput?.getAttribute("aria-describedby")?.split(" ")).toEqual(
      expect.arrayContaining([`${actorInput?.id.replace("actor-id", "hint")}`, status!.id]),
    );
    expect(actorInput?.getAttribute("aria-errormessage")).toBe(status?.id);
    expect(actorInput?.getAttribute("aria-invalid")).toBe("false");
    actorInput!.value = "   ";
    submit(form!);
    expect(humanRequests).toEqual([]);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("成员 ID");
    expect(actorInput?.getAttribute("aria-invalid")).toBe("true");

    actorInput!.value = " ";
    actorInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(actorInput?.getAttribute("aria-invalid")).toBe("true");

    actorInput!.value = "  human-lin  ";
    actorInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(actorInput?.getAttribute("aria-invalid")).toBe("false");
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
    expect(actorInput?.getAttribute("aria-invalid")).toBe("false");
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
    const permissionFieldset = form?.querySelector<HTMLFieldSetElement>("fieldset");

    expect(form).not.toBeNull();
    expect(status?.id).not.toBe("");
    for (const control of [agentSelect, participation, permissionFieldset]) {
      expect(control?.getAttribute("aria-describedby")).toContain(status?.id);
      expect(control?.getAttribute("aria-errormessage")).toBe(status?.id);
      expect(control?.getAttribute("aria-invalid")).toBe("false");
    }
    submit(form!);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("Agent");
    expect(agentSelect?.getAttribute("aria-invalid")).toBe("true");
    expect(participation?.getAttribute("aria-invalid")).toBe("false");
    expect(permissionFieldset?.getAttribute("aria-invalid")).toBe("false");

    agentSelect!.value = "agent-research";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(agentSelect?.getAttribute("aria-invalid")).toBe("false");
    submit(form!);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("参与度");
    expect(participation?.getAttribute("aria-invalid")).toBe("true");

    participation!.value = "on-mention";
    participation!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(participation?.getAttribute("aria-invalid")).toBe("false");
    submit(form!);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("工具权限");
    expect(permissionFieldset?.getAttribute("aria-invalid")).toBe("true");

    let searchPermission = form?.querySelector<HTMLInputElement>(
      "input[name='toolPermissions'][value='search']",
    );
    expect(searchPermission).not.toBeNull();
    searchPermission!.checked = true;
    searchPermission!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(permissionFieldset?.getAttribute("aria-invalid")).toBe("false");

    searchPermission!.value = "shell";
    submit(form!);
    expect(agentRequests).toEqual([]);
    expect(status?.textContent).toContain("工具权限");
    expect(permissionFieldset?.getAttribute("aria-invalid")).toBe("true");

    searchPermission = form?.querySelector<HTMLInputElement>(
      "input[name='toolPermissions'][value='search']",
    );
    searchPermission!.checked = true;
    searchPermission!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(permissionFieldset?.getAttribute("aria-invalid")).toBe("false");
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
    expect(agentSelect?.getAttribute("aria-invalid")).toBe("false");
    expect(participation?.getAttribute("aria-invalid")).toBe("false");
    expect(permissionFieldset?.getAttribute("aria-invalid")).toBe("false");
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
    expect(validAgentSelect?.getAttribute("aria-invalid")).toBe("true");
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
    expect(agentSelect?.getAttribute("aria-invalid")).toBe("false");
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
      expect(agentSelect?.getAttribute("aria-invalid")).toBe("true");
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
    expect(agentSelect?.getAttribute("aria-invalid")).toBe("false");
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
    expect(agentSelect?.getAttribute("aria-invalid")).toBe("true");
    submit(form!);

    expect(requests).toEqual([]);
    expect(root.querySelector("[data-join-kind='agent-configuration'] [role='status']")?.textContent)
      .toContain("没有已声明的工具权限");

    agentSelect!.value = "agent-research";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submitButton?.disabled).toBe(false);
    expect(agentSelect?.getAttribute("aria-invalid")).toBe("false");
    expect(
      Array.from(form?.querySelectorAll<HTMLInputElement>("input[name='toolPermissions']") ?? [])
        .every((input) => !input.checked),
    ).toBe(true);

    submit(form!);
    expect(requests).toEqual([]);
  });
});
