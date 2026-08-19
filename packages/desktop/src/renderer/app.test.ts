import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GovernanceBridge, GovernanceRemoteState } from "../governance/contracts.js";
import type {
  AgentActor,
  AgentConfigurationRequest,
  AgentExecution,
  AgentJudgement,
  CalibrationSignal,
  HumanReadReceipt,
  HumanInvitationRequest,
  LightTask,
  NeedsActionProjection,
  OpenItem,
  RouteJudgment,
  SocialReaction,
} from "@native-im/core";
import * as importedApp from "./app.js";

interface RestoredPrimitivePreviewRecords {
  readonly humanReads: readonly HumanReadReceipt[];
  readonly agentJudgements: readonly AgentJudgement[];
  readonly routeJudgments: readonly RouteJudgment[];
  readonly openItems: readonly OpenItem[];
  readonly lightTasks: readonly LightTask[];
  readonly agentExecutions: readonly AgentExecution[];
  readonly socialReactions: readonly SocialReaction[];
  readonly calibrations: readonly CalibrationSignal[];
}

type RendererUnderTest = {
  renderToolConfirmation?: (
    root: HTMLElement,
    confirmation: {
      readonly confirmationId: string;
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly toolId: string;
      readonly target: string;
      readonly impact: string;
      readonly reversibility: "compensatable" | "irreversible";
      readonly expiresAt: string;
    },
    onConfirm: (input: { readonly confirmationId: string; readonly executionId: string }) => void,
  ) => void;
  renderAgentExecutionPreview?: (
    root: HTMLElement,
    preview: {
      readonly roomId: string;
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly streamSeq: number;
      readonly delta: string;
      readonly authoritative: false;
    } | undefined,
  ) => void;
  renderHumanPreemptionNotice?: (
    root: HTMLElement,
    notice: {
      readonly roomId: string;
      readonly sourceHumanMessageId: string;
      readonly cancelledExecutionIds: readonly string[];
      readonly rerouteStatus: "queued";
      readonly occurredAt: string;
    },
  ) => void;
  renderRoomAttentionSummary?: (
    root: HTMLElement,
    input: { readonly unreadCount: number; readonly needsAction: readonly NeedsActionProjection[] },
  ) => void;
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
};

const app = importedApp as unknown as RendererUnderTest;

describe("empty group chat renderer", () => {
  it("renders unread and room-scoped needs-action independently", () => {
    const root = document.createElement("main");
    app.renderRoomAttentionSummary?.(root, {
      unreadCount: 0,
      needsAction: [{
        roomId: "room-1", actorId: "human-1", overdue: false,
        ball: {
          holderId: "human-1", roomId: "room-1", sourceKind: "open-item",
          sourceId: "item-1", reason: "open item awaits current owner",
          since: "2026-08-17T00:00:00.000Z", deadline: "2026-08-18T00:00:00.000Z",
        },
      }],
    });
    expect(root.querySelector("[data-unread-count='0']")?.textContent).toContain("纯未读 · 0");
    expect(root.querySelector("[data-needs-action-count='1']")?.textContent).toContain("需要我动 · 1");
    expect(root.querySelector("[data-source-id='item-1']")).not.toBeNull();
  });

  it("renders a visible empty collaboration room without pretending an agent is a human", () => {
    const root = document.createElement("main");

    expect(app.renderEmptyGroupChat).toBeTypeOf("function");
    app.renderEmptyGroupChat?.(root);

    expect(root.querySelector("[data-testid='empty-group-chat']")).not.toBeNull();
    expect(root.textContent).toContain("还没有消息");
    expect(root.textContent).toContain("邀请真人或编制 agent 后开始协作");
  });
});

describe("room governance projection", () => {
  it("shows the authoritative owner and the owner/admin management matrix without colour-only cues", () => {
    const root = document.createElement("main");
    importedApp.renderRoomGovernanceProjection(root, {
      governance: {
        roomId: "room-1", projectId: "room-1", lifecycle: "active",
        governanceRevision: 4, ownerActorId: "human-owner", archiveGeneration: 0,
      },
      memberships: [
        { kind: "human", actorId: "human-owner", role: "member", joinedAt: "2026-08-18T00:00:00.000Z" },
        { kind: "human", actorId: "human-admin", role: "admin", joinedAt: "2026-08-18T00:00:00.000Z" },
        { kind: "human", actorId: "human-member", role: "member", joinedAt: "2026-08-18T00:00:00.000Z" },
        { kind: "agent", actorId: "agent-1", participation: "active", toolPermissions: ["search"], configuredAt: "2026-08-18T00:00:00.000Z" },
      ],
      viewerActorId: "human-admin",
    });

    expect(root.querySelector("section")?.getAttribute("aria-label")).toBe("房间治理权限");
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("治理版本 4");
    expect(root.querySelector("[data-actor-id='human-owner']")?.getAttribute("data-role")).toBe("owner");
    expect(root.querySelector("[data-actor-id='human-owner']")?.getAttribute("data-manageable")).toBe("false");
    expect(root.querySelector("[data-actor-id='human-admin']")?.getAttribute("data-manageable")).toBe("false");
    expect(root.querySelector("[data-actor-id='human-member']")?.textContent).toContain("可管理");
    expect(root.querySelector("[data-actor-id='agent-1']")?.textContent).toContain("可管理");
  });

  it("rejects a projection whose canonical owner is not a current Human member", () => {
    const root = document.createElement("main");
    expect(() => importedApp.renderRoomGovernanceProjection(root, {
      governance: {
        roomId: "room-1", projectId: "room-1", lifecycle: "active",
        governanceRevision: 1, ownerActorId: "missing", archiveGeneration: 0,
      },
      memberships: [],
      viewerActorId: "human-admin",
    })).toThrow("owner projection is inconsistent");
  });
});

describe("live closed Governance surface", () => {
  it("renders submit/ACK/event projection convergence, final conflicts, and redacted revoke", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const projection = {
      roomId: "room-1", projectId: "room-1", roomName: "Alpha", lifecycle: "active" as const,
      governanceRevision: 7, archiveGeneration: 0, ownerActorId: "owner-1",
      members: [
        { kind: "human" as const, actorId: "owner-1", displayName: "Owner", role: "member" as const },
        { kind: "human" as const, actorId: "member-1", displayName: "Member", role: "member" as const },
      ],
    };
    const initial: GovernanceRemoteState = {
      status: "ready", projection, viewerActorId: "owner-1",
      connection: { status: "online" }, operation: { status: "idle" },
    };
    let listener: ((state: { readonly roomId: string; readonly state: GovernanceRemoteState }) => void) | undefined;
    const submit = vi.fn(async () => ({
      requestId: "request-archive",
      state: {
        ...initial,
        operation: { status: "submitting" as const, requestId: "request-archive", command: "room.archive" as const },
      },
    }));
    const unsubscribe = vi.fn();
    const bridge: GovernanceBridge = {
      getSurface: vi.fn(async () => initial),
      getDepartureConflicts: vi.fn(),
      submit,
      onStateChanged(callback) { listener = callback; return unsubscribe; },
    };
    const navigate = vi.fn();
    const dispose = importedApp.mountGovernanceSurface(root, bridge, {
      roomId: "room-1", reducedMotion: true, onNavigateConflictResolution: navigate,
    });
    await vi.waitFor(() => expect(root.querySelector("[data-archive-room]")).not.toBeNull());
    root.querySelector<HTMLButtonElement>("[data-archive-room]")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='confirm-archive']")?.click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith({
      roomId: "room-1", intent: { command: "room.archive", expectedGovernanceRevision: 7 },
    }));
    await vi.waitFor(() => expect(root.querySelector("[aria-live='polite']")?.textContent)
      .toContain("正在提交归档"));

    listener?.({
      roomId: "room-1",
      state: {
        ...initial,
        operation: { status: "acknowledged", requestId: "request-archive", command: "room.archive" },
      },
    });
    expect(root.querySelector("[data-archived-banner]")).toBeNull();
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("等待 stable event");

    const archived = {
      ...projection,
      lifecycle: "archived" as const,
      governanceRevision: 8,
      archiveGeneration: 1,
      archivedAt: "2026-08-19T08:00:00.000Z",
    };
    listener?.({
      roomId: "room-1",
      state: {
        ...initial,
        projection: archived,
        operation: { status: "succeeded", requestId: "request-archive", command: "room.archive" },
      },
    });
    expect(root.querySelector("[data-archived-banner]")).not.toBeNull();
    expect(document.activeElement).toBe(root.querySelector("[data-governance-success]"));

    const finalConflicts = {
      roomId: "room-1", targetActorId: "member-1", governanceRevision: 8,
      conflicts: [{
        conflictId: "final-conflict", roomId: "room-1", subjectId: "request-1",
        kind: "request" as const, summary: "Final conflict", state: "accepted",
        sourceRef: "request-1", revision: 2, allowedResolutions: ["transfer" as const],
      }],
    };
    listener?.({
      roomId: "room-1",
      state: {
        ...initial,
        projection: archived,
        departureConflicts: finalConflicts,
        operation: {
          status: "failed", requestId: "request-remove", command: "room.member.remove",
          error: { status: 409, code: "departure_blocked", details: finalConflicts },
        },
      },
    });
    expect(root.querySelector("[data-conflict-id='final-conflict']")?.textContent).toContain("Final conflict");
    expect(document.activeElement).toBe(root.querySelector("[data-departure-conflicts] h2"));

    listener?.({
      roomId: "room-1",
      state: {
        status: "locked", roomId: "room-1",
        connection: { status: "revoked", scope: "room", purgeCompleted: true },
      },
    });
    expect(root.querySelector("[data-governance-locked]")?.textContent).toContain("缓存已清除");
    expect(root.textContent).not.toContain("Alpha");
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    root.remove();
  });
});

describe("ephemeral Agent execution preview", () => {
  it("keeps ordered partial text non-authoritative and clears it without a typing animation", () => {
    const renderer = importedApp as RendererUnderTest;
    const root = document.createElement("div");
    const render = renderer.renderAgentExecutionPreview!;
    render(root, {
      roomId: "room-1",
      executionId: "execution-1",
      attemptSeq: 1,
      streamSeq: 2,
      delta: "partial",
      authoritative: false,
    });
    render(root, {
      roomId: "room-1",
      executionId: "execution-1",
      attemptSeq: 1,
      streamSeq: 1,
      delta: "stale",
      authoritative: false,
    });
    const preview = root.querySelector<HTMLElement>("[data-agent-execution-preview]");
    expect(preview?.textContent).toBe("partial");
    expect(preview?.dataset.authoritative).toBe("false");
    expect(preview?.classList.contains("typing")).toBe(false);
    render(root, undefined);
    expect(root.childElementCount).toBe(0);
  });
});

describe("human preemption presentation", () => {
  it("renders a separate notice and cancelled/requeued execution states without withdrawal or failure", () => {
    const noticeRoot = document.createElement("div");
    app.renderHumanPreemptionNotice?.(noticeRoot, {
      roomId: "preview-room",
      sourceHumanMessageId: "preview-human-mention",
      cancelledExecutionIds: ["execution-old"],
      rerouteStatus: "queued",
      occurredAt: "2026-08-17T00:00:02.000Z",
    });
    expect(noticeRoot.querySelector(".human-preemption-notice")?.textContent)
      .toContain("1 个旧 Agent 执行已取消并重新判定");

    const root = document.createElement("main");
    app.renderM2PrimitivesPreview?.(root, {
      humanReads: [], agentJudgements: [], routeJudgments: [], openItems: [], lightTasks: [],
      socialReactions: [], calibrations: [],
      agentExecutions: [
        {
          id: "execution-old", roomId: "preview-room", sourceMessageId: "preview-agent-data",
          requesterId: "human-li", agentId: "agent-data", toolName: "model.generate",
          status: "cancelled", actionCategory: "waiting_upstream", currentAttemptSeq: 1,
          retryCycle: 1, retryOrdinal: 1, recoveryCursor: 1,
          queuedAt: "2026-08-17T00:00:00.000Z", startedAt: "2026-08-17T00:00:01.000Z",
          updatedAt: "2026-08-17T00:00:02.000Z", completedAt: "2026-08-17T00:00:02.000Z",
          cancellationReason: "human_preempted:preview-human-mention",
        },
        {
          id: "execution-new", roomId: "preview-room", sourceMessageId: "preview-human-mention",
          requesterId: "human-li", agentId: "agent-data", toolName: "model.generate",
          status: "queued", actionCategory: "model_generation", currentAttemptSeq: 1,
          retryCycle: 1, retryOrdinal: 1, recoveryCursor: 0,
          queuedAt: "2026-08-17T00:00:03.000Z", updatedAt: "2026-08-17T00:00:03.000Z",
          supersedesExecutionIds: ["execution-old"],
        },
      ],
    });

    expect(root.querySelector(".agent-invocation--human-preempted")?.textContent)
      .toContain("因人类发言已取消");
    expect(root.querySelector(".agent-invocation--requeued")?.textContent).toContain("已重新排队");
    expect(root.querySelector(".agent-invocation--requeued")?.getAttribute("data-supersedes-execution-ids"))
      .toBe("execution-old");
    const executionText = [...root.querySelectorAll(".agent-invocation")]
      .map((element) => element.textContent).join(" ");
    expect(executionText).not.toContain("撤回");
    expect(executionText).not.toContain("调用失败");
  });
});

describe("side-effect confirmation renderer", () => {
  it("shows target, impact, reversibility, and expiry and emits one closed confirmation", () => {
    const root = document.createElement("div");
    const confirmations: Array<{ readonly confirmationId: string; readonly executionId: string }> = [];
    app.renderToolConfirmation?.(root, {
      confirmationId: "confirmation-1",
      executionId: "execution-1",
      attemptSeq: 2,
      toolId: "sandbox-file.write",
      target: "sandbox-file.write",
      impact: "bounded-side-effect",
      reversibility: "compensatable",
      expiresAt: "2026-08-17T00:05:00.000Z",
    }, (input) => confirmations.push(input));
    expect(root.textContent).toContain("目标：sandbox-file.write");
    expect(root.textContent).toContain("影响：bounded-side-effect");
    expect(root.textContent).toContain("可逆性：compensatable");
    expect(root.textContent).toContain("过期：2026-08-17T00:05:00.000Z");
    const button = root.querySelector<HTMLButtonElement>("button");
    button?.click();
    button?.click();
    expect(confirmations).toEqual([{ confirmationId: "confirmation-1", executionId: "execution-1" }]);
    expect(button?.disabled).toBe(true);
  });
});

describe("verified collaboration primitive renderer", () => {
  it("rejects malformed or unrelated restored records before mutating the DOM", () => {
    const empty = (): RestoredPrimitivePreviewRecords => ({
      humanReads: [], agentJudgements: [], routeJudgments: [], openItems: [], lightTasks: [], agentExecutions: [],
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
        requesterId: "human-a", currentOwnerId: "human-a", content: "closed",
        status: "awaiting", origin: { kind: "human_mention" },
        createdAt: "2026-08-12T00:00:00.000Z",
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
      routeJudgments: [{
        id: "route-judgment-restored",
        routeJobId: "route-job-restored",
        sourceMessageId: "preview-human-mention",
        agentId: "agent-data",
        outcome: "suppressed",
        reasonCode: "cooldown",
        reasonText: "同话题冷却期尚未结束",
        routeAttempt: 2,
        decidedAt: "2026-08-12T13:00:01.500Z",
      }],
      openItems: [{
        id: "open-restored",
        roomId: "preview-room",
        sourceMessageId: "preview-agent-data",
        requesterId: "恢复请求者",
        currentOwnerId: "恢复负责人",
        content: "恢复后的待答问题",
        status: "awaiting",
        origin: { kind: "manual_unfinished" },
        createdAt: "2026-08-12T13:00:02.000Z",
        transferChain: [],
      }],
      lightTasks: [],
      agentExecutions: [{
        id: "execution-restored",
        roomId: "preview-room",
        sourceMessageId: "preview-human-mention",
        requesterId: "恢复请求者",
        agentId: "恢复 Agent",
        toolName: "restore.inspect",
        status: "running",
        actionCategory: "model_generation",
        currentAttemptSeq: 1,
        retryCycle: 1,
        retryOrdinal: 1,
        recoveryCursor: 0,
        queuedAt: "2026-08-12T13:00:02.900Z",
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
    const routeJudgment = root.querySelector(".route-judgment");
    const openItem = root.querySelector(".open-item");
    const agentExecution = root.querySelector(".agent-invocation");
    const social = root.querySelector(".reaction--social");
    const calibration = root.querySelector(".reaction--calibration");

    expect(humanRead?.textContent).toContain("恢复用户甲");
    expect(humanRead?.textContent).toContain("已读");
    expect(agentJudgement?.textContent).toContain("恢复后仍会回应");
    expect(agentJudgement?.textContent).toContain("已判定");
    expect(routeJudgment?.textContent).toContain("被抑制");
    expect(routeJudgment?.textContent).toContain("同话题冷却期尚未结束");
    expect(routeJudgment?.getAttribute("data-route-outcome")).toBe("suppressed");
    expect(routeJudgment?.getAttribute("data-route-attempt")).toBe("2");
    expect(routeJudgment?.classList.contains("typing")).toBe(false);
    expect(openItem?.textContent).toContain("恢复后的待答问题");
    expect(openItem?.textContent).toContain("待答项");
    expect(openItem?.textContent).toContain("来源：手动标记未完");
    expect(openItem?.getAttribute("data-source-message-id")).toBe("preview-agent-data");
    expect(openItem?.querySelectorAll(".human-request-action")).toHaveLength(3);
    expect(agentExecution?.textContent).toContain("恢复 Agent 正在调用");
    expect(agentExecution?.textContent).toContain("restore.inspect");
    expect(agentExecution?.textContent).toContain("Agent 执行");
    expect(social?.textContent).toContain("🎉 纯社交");
    expect(calibration?.textContent).toContain("👍 校准：影响后续发言判定");
    expect(humanRead?.getAttribute("data-receipt-kind")).toBe("human-read");
    expect(agentJudgement?.getAttribute("data-receipt-kind")).toBe("agent-judgement");
    expect(openItem?.getAttribute("data-open-item-status")).toBe("awaiting");
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
    expect(root.querySelectorAll("[data-open-item-status='transferred'] .human-request-action"))
      .toHaveLength(3);
    expect(root.querySelector("[data-open-item-status='transferred']")?.textContent)
      .toContain("来源：手动标记未完");
    expect(root.querySelectorAll("[data-agent-invocation] .human-request-action")).toHaveLength(0);

    interrupt?.click();

    expect(root.querySelector("[data-agent-invocation]")?.getAttribute("data-execution-status")).toBe("cancelled");
    expect(root.querySelector("[data-member-id='agent-data']")?.textContent).toBe("可用");
  });

  it("renders D-01 content, unique owner, source, four states, and active human actions", () => {
    const root = document.createElement("main");
    const common = {
      roomId: "preview-room", sourceMessageId: "preview-agent-data",
      requesterId: "human-requester", content: "D-01 commitment",
      origin: { kind: "manual_unfinished" as const }, createdAt: "2026-08-12T00:00:00.000Z",
    };
    app.renderM2PrimitivesPreview?.(root, {
      humanReads: [], agentJudgements: [], routeJudgments: [], agentExecutions: [],
      lightTasks: [], socialReactions: [], calibrations: [],
      openItems: [
        { ...common, id: "item-awaiting", currentOwnerId: "human-owner", status: "awaiting", transferChain: [] },
        { ...common, id: "item-transferred", currentOwnerId: "human-next", status: "transferred",
          transferChain: [{ fromId: "human-owner", toId: "human-next", reason: "handoff",
            transferredAt: "2026-08-12T00:01:00.000Z" }] },
        { ...common, id: "item-answered", currentOwnerId: null, status: "answered", transferChain: [],
          respondedAt: "2026-08-12T00:02:00.000Z" },
        { ...common, id: "item-deferred", currentOwnerId: null, status: "deferred", transferChain: [],
          respondedAt: "2026-08-12T00:03:00.000Z" },
      ],
    });
    expect(root.querySelector("[data-open-item-status='awaiting']")?.textContent)
      .toContain("human-owner · 待回应");
    expect(root.querySelector("[data-open-item-status='transferred']")?.textContent)
      .toContain("human-next · 已转交");
    expect(root.querySelector("[data-open-item-status='answered']")?.textContent)
      .toContain("已闭合 · 已回应");
    expect(root.querySelector("[data-open-item-status='deferred']")?.textContent)
      .toContain("已闭合 · 已搁置");
    expect(root.querySelectorAll("[data-open-item-status='awaiting'] .human-request-action"))
      .toHaveLength(3);
    expect(root.querySelectorAll("[data-open-item-status='transferred'] .human-request-action"))
      .toHaveLength(3);
    expect(root.querySelectorAll("[data-open-item-status='answered'] .human-request-action"))
      .toHaveLength(0);
    expect(root.querySelectorAll("[data-open-item-status='deferred'] .human-request-action"))
      .toHaveLength(0);
  });

  it("renders LightTask four states, audit actors, verifier role, and criteria without GBP controls", () => {
    const root = document.createElement("main");
    const common = {
      roomId: "preview-room", sourceMessageId: "preview-human-mention", title: "完成评审",
      verifierRole: "owner" as const,
      criteria: [{ id: "criterion-1", text: "评审通过", met: false }],
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    app.renderM2PrimitivesPreview?.(root, {
      humanReads: [], agentJudgements: [], routeJudgments: [], openItems: [], agentExecutions: [],
      socialReactions: [], calibrations: [],
      lightTasks: [
        { ...common, id: "task-todo", claimant: null, claimantRoleAtClaim: null,
          verifierActorId: null, status: "todo" },
        { ...common, id: "task-claimed", claimant: "human-claimant", claimantRoleAtClaim: "member",
          verifierActorId: null, status: "claimed", claimedAt: "2026-08-17T00:01:00.000Z" },
        { ...common, id: "task-delivered", claimant: "human-claimant", claimantRoleAtClaim: "member",
          verifierActorId: "human-owner", status: "delivered",
          claimedAt: "2026-08-17T00:01:00.000Z", deliveredAt: "2026-08-17T00:02:00.000Z" },
        { ...common, id: "task-verified", claimant: "human-claimant", claimantRoleAtClaim: "member",
          verifierActorId: "human-owner", status: "verified",
          criteria: [{ id: "criterion-1", text: "评审通过", met: true }],
          claimedAt: "2026-08-17T00:01:00.000Z", deliveredAt: "2026-08-17T00:02:00.000Z",
          verifiedAt: "2026-08-17T00:03:00.000Z" },
      ],
    });
    expect(root.querySelectorAll(".light-task")).toHaveLength(4);
    expect(root.querySelector("[data-light-task-status='todo']")?.textContent)
      .toContain("未认领");
    expect(root.querySelector("[data-light-task-status='claimed']")?.textContent)
      .toContain("认领人：human-claimant");
    expect(root.querySelector("[data-light-task-status='delivered']")?.textContent)
      .toContain("验收角色：owner · 验收人：human-owner");
    expect(root.querySelector("[data-light-task-status='verified'] [data-criterion-met='true']")
      ?.textContent).toContain("✓ 评审通过");
    expect(root.querySelector(".light-task")?.textContent).not.toMatch(/deps|maturity|milestone|依赖|里程碑/);
    expect(root.querySelector(".light-task [data-action='dependency']")).toBeNull();
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
    const localStyles = resolve(process.cwd(), "src/renderer/styles.css");
    const styles = readFileSync(
      existsSync(localStyles)
        ? localStyles
        : resolve(process.cwd(), "packages/desktop/src/renderer/styles.css"),
      "utf8",
    );
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
