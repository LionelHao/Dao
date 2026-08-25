import {
  isAgentExecution,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isHumanPreemptionNotice,
  isLightTask,
  isNeedsActionProjection,
  isOpenItem,
  isRouteJudgment,
  isSocialReaction,
  isRoomGovernanceView,
  isHumanRoomMembership,
  isAgentRoomMembership,
  type Actor,
  type AgentActor,
  type AgentConfigurationRequest,
  type AgentExecution,
  type AgentJudgement,
  type AgentParticipation,
  type CalibrationSignal,
  type HumanActor,
  type HumanInvitationRequest,
  type HumanReadReceipt,
  type HumanPreemptionNotice,
  type LightTask,
  type NeedsActionProjection,
  type Message,
  type OpenItem,
  type RouteJudgment,
  type SocialReaction,
  type ToolConfirmationInput,
  type ToolConfirmationRequiredPayload,
  type RoomGovernanceView,
  type ManagedRoom,
} from "@native-im/core";
import type { GovernanceBridge, GovernanceRemoteState } from "../governance/contracts.js";
import {
  renderGovernanceSurface as renderGovernanceFeatureSurface,
} from "./governance/governance-surface.js";
import type {
  DepartureConflict,
  DepartureResolution,
  GovernanceDialog,
  GovernanceSurfaceState,
} from "./governance/view-model.js";

function renderLockedGovernance(root: HTMLElement, state: Extract<GovernanceRemoteState, { status: "locked" }>): void {
  const locked = document.createElement("section");
  locked.className = "governance-locked";
  locked.dataset.governanceLocked = "true";
  locked.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = state.connection.status === "revoked" ? "Room 访问已撤销"
    : state.connection.status === "offline" ? "Room 离线且无有效读取 lease" : "治理服务不可用";
  const explanation = document.createElement("p");
  explanation.textContent = state.connection.status === "revoked"
    ? state.connection.purgeCompleted ? "缓存已清除" : "正在清除缓存"
    : state.connection.status === "offline" ? `缓存不能作为权威来源 · 离线于 ${state.connection.asOf}`
    : `无法安全显示 Room · ${state.connection.errorCode}`;
  locked.append(heading, explanation);
  root.replaceChildren(locked);
}

export function mountGovernanceSurface(
  root: HTMLElement,
  bridge: GovernanceBridge,
  options: {
    readonly roomId: string;
    readonly reducedMotion: boolean;
    readonly onNavigateConflictResolution: (
      conflict: DepartureConflict,
      resolution: DepartureResolution,
    ) => void;
  },
): () => void {
  let active = true;
  let remote: Extract<GovernanceRemoteState, { status: "ready" }> | undefined;
  let dialog: GovernanceDialog | null = null;
  let authoritySequence = 0;

  const render = (): void => {
    if (remote === undefined) return;
    const state: GovernanceSurfaceState = {
      projection: remote.projection,
      viewerActorId: remote.viewerActorId,
      connection: remote.connection,
      operation: remote.operation,
      ...(remote.departureConflicts === undefined
        ? {} : { departureConflicts: remote.departureConflicts }),
      dialog,
      reducedMotion: options.reducedMotion,
    };
    renderGovernanceFeatureSurface(root, state, {
      onIntent(intent) {
        dialog = null;
        render();
        void bridge.submit({ roomId: options.roomId, intent }).then((result) => {
          if (active) applyRemote(result.state);
        }).catch(() => {
          if (active) void refresh();
        });
      },
      onOpenDialog(next) {
        dialog = next;
        render();
      },
      onRetry(error) {
        if (error.status === 409 && error.code === "departure_blocked" &&
            remote?.departureConflicts !== undefined) {
          const current = remote;
          const conflicts = current.departureConflicts;
          if (conflicts === undefined) return;
          void bridge.getDepartureConflicts({
            roomId: options.roomId,
            targetActorId: conflicts.targetActorId,
            expectedGovernanceRevision: current.projection.governanceRevision,
          }).then((conflicts) => {
            if (!active || remote === undefined) return;
            remote = { ...remote, departureConflicts: conflicts };
            dialog = "departure_conflicts";
            render();
          }).catch(() => undefined);
        } else {
          void refresh();
        }
      },
      onResolveConflict: options.onNavigateConflictResolution,
      onCloseDialog(closed) {
        if (dialog === closed) dialog = null;
        render();
      },
    });
  };

  const applyRemote = (state: GovernanceRemoteState): void => {
    authoritySequence += 1;
    if (state.status === "locked") {
      remote = undefined;
      dialog = null;
      renderLockedGovernance(root, state);
      return;
    }
    if (state.projection.roomId !== options.roomId) return;
    remote = state;
    if (state.operation.status === "failed" &&
        state.operation.error.status === 409 &&
        state.operation.error.code === "departure_blocked") {
      dialog = "departure_conflicts";
    }
    render();
  };

  const refresh = async (): Promise<void> => {
    const startedAt = authoritySequence;
    try {
      const state = await bridge.getSurface({ roomId: options.roomId });
      if (active && authoritySequence === startedAt) applyRemote(state);
    } catch {
      if (active && authoritySequence === startedAt) {
        applyRemote({
          status: "locked", roomId: options.roomId,
          connection: { status: "fatal", errorCode: "governance_bridge_unavailable" },
        });
      }
    }
  };

  const loading = document.createElement("p");
  loading.setAttribute("role", "status");
  loading.textContent = "正在载入 Room 治理权威状态";
  root.replaceChildren(loading);
  const unsubscribe = bridge.onStateChanged((envelope) => {
    if (active && envelope.roomId === options.roomId) applyRemote(envelope.state);
  });
  void refresh();
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
  };
}

export function renderRoomGovernanceProjection(
  root: HTMLElement,
  input: {
    readonly governance: RoomGovernanceView;
    readonly memberships: ManagedRoom["members"];
    readonly viewerActorId: string;
  },
): void {
  if (!isRoomGovernanceView(input.governance) ||
      !input.memberships.every((membership) =>
        isHumanRoomMembership(membership) || isAgentRoomMembership(membership))) {
    throw new TypeError("Room governance projection is not closed");
  }
  const humans = input.memberships.filter(isHumanRoomMembership);
  if (humans.filter((member) => member.actorId === input.governance.ownerActorId).length !== 1) {
    throw new TypeError("Room governance owner projection is inconsistent");
  }
  const viewer = humans.find((member) => member.actorId === input.viewerActorId);
  const viewerRole = input.viewerActorId === input.governance.ownerActorId
    ? "owner"
    : viewer?.role;
  const panel = document.createElement("section");
  panel.className = "room-governance";
  panel.dataset.roomId = input.governance.roomId;
  panel.dataset.projectId = input.governance.projectId;
  panel.dataset.governanceRevision = String(input.governance.governanceRevision);
  panel.dataset.viewerRole = viewerRole ?? "none";
  panel.setAttribute("aria-label", "房间治理权限");
  const heading = document.createElement("h2");
  heading.textContent = "成员与权限";
  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  status.textContent = `当前角色：${viewerRole ?? "无权限"} · 治理版本 ${input.governance.governanceRevision}`;
  const list = document.createElement("ul");
  for (const membership of input.memberships) {
    const item = document.createElement("li");
    item.dataset.actorId = membership.actorId;
    const projectedRole = membership.kind === "agent"
      ? "agent"
      : membership.actorId === input.governance.ownerActorId ? "owner" : membership.role;
    item.dataset.role = projectedRole;
    const manageable = viewerRole === "owner"
      ? projectedRole !== "owner"
      : viewerRole === "admin" &&
        (projectedRole === "member" || projectedRole === "agent");
    item.dataset.manageable = String(manageable);
    item.textContent = `${membership.actorId} · ${projectedRole} · ${manageable ? "可管理" : "不可管理"}`;
    list.append(item);
  }
  panel.append(heading, status, list);
  root.replaceChildren(panel);
}

export function renderRoomAttentionSummary(
  root: HTMLElement,
  input: { readonly unreadCount: number; readonly needsAction: readonly NeedsActionProjection[] },
): void {
  if (!Number.isSafeInteger(input.unreadCount) || input.unreadCount < 0 ||
      input.needsAction.length > 256 || !input.needsAction.every(isNeedsActionProjection)) {
    throw new TypeError("Room attention summary is not closed");
  }
  const panel = document.createElement("section");
  panel.className = "room-attention-summary";
  panel.setAttribute("aria-label", "房间关注摘要");
  const unread = document.createElement("p");
  unread.className = "room-attention-summary__unread";
  unread.dataset.unreadCount = String(input.unreadCount);
  unread.textContent = `纯未读 · ${input.unreadCount}`;
  const actions = document.createElement("section");
  actions.className = "room-attention-summary__needs-action";
  actions.dataset.needsActionCount = String(input.needsAction.length);
  const heading = document.createElement("h2");
  heading.textContent = `需要我动 · ${input.needsAction.length}`;
  actions.append(heading);
  for (const entry of input.needsAction) {
    const item = document.createElement("article");
    item.className = "needs-action-item";
    item.dataset.sourceKind = entry.ball.sourceKind;
    item.dataset.sourceId = entry.ball.sourceId;
    item.dataset.overdue = String(entry.overdue);
    item.textContent = `${entry.ball.reason} · ${entry.overdue ? "已逾期" : "待处理"}`;
    actions.append(item);
  }
  panel.append(unread, actions);
  root.replaceChildren(panel);
}

export interface RestoredPrimitivePreviewRecords {
  readonly humanReads: readonly HumanReadReceipt[];
  readonly agentJudgements: readonly AgentJudgement[];
  readonly routeJudgments: readonly RouteJudgment[];
  readonly openItems: readonly OpenItem[];
  readonly lightTasks: readonly LightTask[];
  readonly agentExecutions: readonly AgentExecution[];
  readonly socialReactions: readonly SocialReaction[];
  readonly calibrations: readonly CalibrationSignal[];
}

export interface AgentExecutionPreview {
  readonly roomId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly streamSeq: number;
  readonly delta: string;
  readonly authoritative: false;
}

export function renderAgentExecutionPreview(
  root: HTMLElement,
  preview: AgentExecutionPreview | undefined,
): void {
  if (preview === undefined) {
    root.replaceChildren();
    return;
  }
  const current = root.querySelector<HTMLElement>("[data-agent-execution-preview]");
  const currentAttempt = Number(current?.dataset.attemptSeq ?? 0);
  const currentSequence = Number(current?.dataset.streamSeq ?? 0);
  if (
    current !== null &&
    current.dataset.executionId === preview.executionId &&
    (preview.attemptSeq < currentAttempt ||
      (preview.attemptSeq === currentAttempt && preview.streamSeq <= currentSequence))
  ) {
    return;
  }
  const element = current?.dataset.executionId === preview.executionId
    ? current
    : document.createElement("aside");
  if (element !== current) {
    element.className = "agent-execution-preview";
    element.dataset.agentExecutionPreview = "true";
    element.dataset.authoritative = "false";
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-label", "Agent 非权威临时预览");
    element.textContent = "";
  }
  if (preview.attemptSeq > currentAttempt) element.textContent = "";
  element.dataset.executionId = preview.executionId;
  element.dataset.attemptSeq = String(preview.attemptSeq);
  element.dataset.streamSeq = String(preview.streamSeq);
  element.textContent = `${element.textContent ?? ""}${preview.delta}`;
  root.replaceChildren(element);
}

export function renderHumanPreemptionNotice(
  root: HTMLElement,
  notice: HumanPreemptionNotice,
): void {
  if (!isHumanPreemptionNotice(notice)) {
    throw new TypeError("Human preemption notice is not closed");
  }
  const element = document.createElement("aside");
  element.className = "human-preemption-notice";
  element.dataset.sourceHumanMessageId = notice.sourceHumanMessageId;
  element.dataset.cancelledExecutionCount = String(notice.cancelledExecutionIds.length);
  element.dataset.rerouteStatus = notice.rerouteStatus;
  element.setAttribute("aria-live", "polite");
  element.textContent = notice.cancelledExecutionIds.length === 0
    ? "检测到人类发言，Agent 发言判定已刷新"
    : `检测到人类发言，${notice.cancelledExecutionIds.length} 个旧 Agent 执行已取消并重新判定`;
  root.replaceChildren(element);
}

export function renderToolConfirmation(
  root: HTMLElement,
  confirmation: ToolConfirmationRequiredPayload,
  onConfirm: (input: ToolConfirmationInput) => void,
): void {
  const card = document.createElement("section");
  card.className = "agent-tool-confirmation";
  card.dataset.toolConfirmation = confirmation.confirmationId;
  card.setAttribute("aria-label", "Agent 工具副作用确认");
  const details = document.createElement("p");
  details.textContent = `目标：${confirmation.target} · 影响：${confirmation.impact} · 可逆性：${confirmation.reversibility} · 过期：${confirmation.expiresAt}`;
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.textContent = "确认执行一次";
  confirm.addEventListener("click", () => {
    confirm.disabled = true;
    onConfirm({
      confirmationId: confirmation.confirmationId,
      executionId: confirmation.executionId,
    });
  }, { once: true });
  card.append(details, confirm);
  root.replaceChildren(card);
}

export interface RoomJoinControlOptions {
  readonly roomId: string;
  readonly agents: readonly AgentActor[];
  readonly onInviteHuman: (request: HumanInvitationRequest) => void;
  readonly onConfigureAgent: (request: AgentConfigurationRequest) => void;
}

export function renderEmptyGroupChat(root: HTMLElement): void {
  const section = document.createElement("section");
  const title = document.createElement("h1");
  const description = document.createElement("p");

  section.dataset.testid = "empty-group-chat";
  section.className = "empty-group-chat";
  title.textContent = "还没有消息";
  description.textContent = "邀请真人或编制 agent 后开始协作";

  section.append(title, description);
  root.setAttribute("aria-label", "空群聊");
  root.replaceChildren(section);
}

const agentRoleColours = ["#175cd3", "#5b21b6", "#a21caf", "#0e7490", "#344054"] as const;
const semanticStatusColours = new Set(["#027a48", "#b54708", "#b42318"]);

if (agentRoleColours.some((colour) => semanticStatusColours.has(colour))) {
  throw new Error("Agent role colours must not overlap semantic status colours.");
}

interface AgentPresentation {
  readonly colour: string;
  readonly identityFallback: "initial" | "pattern-and-initial";
  readonly paletteSlot: number;
}

function initialFor(displayName: string): string {
  return displayName.trim().slice(0, 1).toUpperCase() || "?";
}

function actorForMessage(message: Message, actor: Actor | undefined): Actor | undefined {
  return actor?.id === message.authorId && actor.kind === message.authorKind ? actor : undefined;
}

function agentPresentationById(messages: readonly Message[]): ReadonlyMap<string, AgentPresentation> {
  const agentIds = Array.from(
    new Set(
      messages
        .filter((message) => message.authorKind === "agent")
        .map((message) => message.authorId),
    ),
  );

  return new Map(
    agentIds.map((agentId, index) => {
      const paletteSlot = index % agentRoleColours.length;
      const colour = agentRoleColours[paletteSlot] ?? agentRoleColours[0]!;

      return [
        agentId,
        {
          colour,
          paletteSlot,
          identityFallback: index < agentRoleColours.length ? "initial" : "pattern-and-initial",
        },
      ];
    }),
  );
}

function fallbackAgentPresentation(): AgentPresentation {
  return {
    colour: agentRoleColours[0]!,
    paletteSlot: 0,
    identityFallback: "initial",
  };
}

function appendMessageHeader(
  content: HTMLElement,
  displayName: string,
  message: Message,
  roleLabel?: string,
): void {
  const header = document.createElement("header");
  const author = document.createElement("span");
  const sentAt = document.createElement("time");

  header.className = "message-header";
  author.className = "message-author";
  author.textContent = displayName;
  sentAt.className = "message-sent-at";
  sentAt.dateTime = message.sentAt;
  sentAt.textContent = message.sentAt;
  header.append(author);

  if (roleLabel !== undefined) {
    const role = document.createElement("span");

    role.className = "message-role-label";
    role.textContent = roleLabel;
    header.append(role);
  }

  header.append(sentAt);
  content.append(header);
}

function renderHumanMessage(message: Message, actor: HumanActor | undefined): HTMLElement {
  const article = document.createElement("article");
  const avatar = document.createElement("span");
  const content = document.createElement("div");
  const bubble = document.createElement("p");
  const displayName = actor?.displayName ?? "成员";

  article.className = "message message--human";
  article.dataset.messageKind = "human";
  article.dataset.messageId = message.id;
  avatar.className = "message-avatar message-avatar--human";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = initialFor(displayName);
  content.className = "message-content";
  bubble.className = "message-bubble";
  bubble.textContent = message.body;

  appendMessageHeader(content, displayName, message);
  content.append(bubble);
  article.append(avatar, content);
  return article;
}

function renderAgentMessage(
  message: Message,
  actor: AgentActor | undefined,
  presentation: AgentPresentation,
): HTMLElement {
  const article = document.createElement("article");
  const rail = document.createElement("span");
  const avatar = document.createElement("span");
  const content = document.createElement("div");
  const body = document.createElement("p");
  const displayName = actor?.displayName ?? "Agent";
  // V1 has no separate role field. Its visible AgentActor.displayName is the
  // role title, so it drives both the label and a stable role-colour rail.
  const roleLabel = displayName;

  article.className = "message message--agent";
  article.dataset.messageKind = "agent";
  article.dataset.messageId = message.id;
  article.dataset.agentPaletteSlot = `${presentation.paletteSlot}`;
  article.dataset.agentIdentityFallback = presentation.identityFallback;
  article.style.setProperty("--message-role-colour", presentation.colour);
  rail.className = "message-role-rail";
  rail.setAttribute("aria-hidden", "true");
  avatar.className = "message-avatar message-avatar--agent";
  if (presentation.identityFallback === "pattern-and-initial") {
    avatar.classList.add("message-avatar--agent-overflow");
  }
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = initialFor(displayName);
  content.className = "message-content";
  body.className = "message-agent-body";
  body.textContent = message.body;

  appendMessageHeader(content, "Agent", message, roleLabel);
  content.append(body);
  article.append(rail, avatar, content);
  return article;
}

function renderMessage(
  message: Message,
  actor: Actor | undefined,
  agentPresentations: ReadonlyMap<string, AgentPresentation>,
): HTMLElement {
  if (actor?.kind === "human") {
    return renderHumanMessage(message, actor);
  }

  if (actor?.kind === "agent") {
    return renderAgentMessage(
      message,
      actor,
      agentPresentations.get(message.authorId) ?? fallbackAgentPresentation(),
    );
  }

  return message.authorKind === "human"
    ? renderHumanMessage(message, undefined)
    : renderAgentMessage(
      message,
      undefined,
      agentPresentations.get(message.authorId) ?? fallbackAgentPresentation(),
    );
}

export function renderMessageTimeline(
  root: HTMLElement,
  messages: readonly Message[],
  actorsById: ReadonlyMap<string, Actor>,
): void {
  if (messages.length === 0) {
    renderEmptyGroupChat(root);
    return;
  }

  const timeline = document.createElement("section");
  const agentPresentations = agentPresentationById(messages);

  timeline.className = "message-timeline";
  timeline.dataset.testid = "message-timeline";
  timeline.setAttribute("aria-label", "群聊消息");

  for (const message of messages) {
    const actor = actorForMessage(message, actorsById.get(message.authorId));
    const rendered = renderMessage(message, actor, agentPresentations);

    timeline.append(rendered);
  }

  root.replaceChildren(timeline);
}

export function renderVisualSeparationPreview(root: HTMLElement): void {
  const preview = document.createElement("section");
  const heading = document.createElement("h1");
  const description = document.createElement("p");
  const timelineRoot = document.createElement("div");
  const messages: readonly Message[] = [
    {
      id: "preview-human-li",
      roomId: "visual-review",
      authorId: "human-li",
      authorKind: "human",
      body: "权限边界请先由人确认，我再决定是否交给 agent 执行。",
      sentAt: "14:20",
    },
    {
      id: "preview-agent-security",
      roomId: "visual-review",
      authorId: "agent-security",
      authorKind: "agent",
      body: "已检索合规库：HR 与合同两类必须走私有化。",
      sentAt: "14:33",
    },
    {
      id: "preview-agent-data",
      roomId: "visual-review",
      authorId: "agent-data",
      authorKind: "agent",
      body: "数据分级清单已整理，等待人确认范围。",
      sentAt: "14:34",
    },
    {
      id: "preview-agent-research",
      roomId: "visual-review",
      authorId: "agent-research",
      authorKind: "agent",
      body: "行业对照已归档，未触发新的执行请求。",
      sentAt: "14:35",
    },
    {
      id: "preview-agent-design",
      roomId: "visual-review",
      authorId: "agent-design",
      authorKind: "agent",
      body: "已补齐移动端的空间约束说明。",
      sentAt: "14:36",
    },
    {
      id: "preview-agent-ops",
      roomId: "visual-review",
      authorId: "agent-ops",
      authorKind: "agent",
      body: "构建门禁状态正常，尚未执行发布动作。",
      sentAt: "14:37",
    },
    {
      id: "preview-agent-audit",
      roomId: "visual-review",
      authorId: "agent-audit",
      authorKind: "agent",
      body: "第六个 agent 使用条纹与首字，避免与前五个角色只靠颜色区分。",
      sentAt: "14:38",
    },
  ];
  const actorsById = new Map<string, Actor>([
    ["human-li", { id: "human-li", kind: "human", displayName: "李乐", reachability: "online" }],
    [
      "agent-security",
      { id: "agent-security", kind: "agent", displayName: "安全 Agent", readiness: "ready", toolPermissions: ["knowledge-base"] },
    ],
    [
      "agent-data",
      { id: "agent-data", kind: "agent", displayName: "数据 Agent", readiness: "ready", toolPermissions: ["warehouse"] },
    ],
    [
      "agent-research",
      { id: "agent-research", kind: "agent", displayName: "研究 Agent", readiness: "busy", toolPermissions: ["search"] },
    ],
    [
      "agent-design",
      { id: "agent-design", kind: "agent", displayName: "设计 Agent", readiness: "ready", toolPermissions: ["design-system"] },
    ],
    [
      "agent-ops",
      { id: "agent-ops", kind: "agent", displayName: "运维 Agent", readiness: "ready", toolPermissions: ["ci"] },
    ],
    [
      "agent-audit",
      { id: "agent-audit", kind: "agent", displayName: "审计 Agent", readiness: "ready", toolPermissions: ["audit-log"] },
    ],
  ]);

  preview.className = "visual-separation-preview";
  heading.textContent = "人 / agent 视觉分离预览";
  description.textContent = "静态审查样本：气泡属于人，角色色轨属于 agent。";
  timelineRoot.className = "visual-separation-preview__timeline";

  renderMessageTimeline(timelineRoot, messages, actorsById);
  preview.append(heading, description, timelineRoot);
  root.dataset.testid = "visual-separation-preview";
  root.setAttribute("aria-label", "人和 agent 的视觉分离预览");
  root.replaceChildren(preview);
}

interface AgentControlOption {
  readonly id: string;
  readonly displayName: string;
  readonly toolPermissions: readonly string[];
}

const agentParticipationLabels: ReadonlyArray<
  readonly [value: AgentParticipation, label: string]
> = [
  ["active", "主动参与"],
  ["on-mention", "被提及时参与"],
];
const agentParticipationValues = new Set<AgentParticipation>(
  agentParticipationLabels.map(([value]) => value),
);
const agentReadinessValues = new Set(["ready", "busy", "paused", "noauth"]);
let roomJoinControlSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseAgents(value: unknown): readonly AgentControlOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const agentsById = new Map<string, AgentControlOption>();

  for (const candidate of value) {
    if (!isRecord(candidate) || candidate.kind !== "agent") {
      continue;
    }

    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const displayName =
      typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
    const permissions = candidate.toolPermissions;

    if (
      id.length === 0 ||
      displayName.length === 0 ||
      !agentReadinessValues.has(candidate.readiness as string) ||
      !Array.isArray(permissions) ||
      !permissions.every((permission) => typeof permission === "string") ||
      agentsById.has(id)
    ) {
      continue;
    }

    agentsById.set(id, {
      id,
      displayName,
      toolPermissions: Array.from(
        new Set(
          permissions
            .map((permission) => permission.trim())
            .filter((permission) => permission.length > 0),
        ),
      ),
    });
  }

  return Array.from(agentsById.values());
}

function createLabel(labelText: string, control: HTMLInputElement | HTMLSelectElement): HTMLLabelElement {
  const label = document.createElement("label");

  label.className = "join-field-label";
  label.htmlFor = control.id;
  label.textContent = labelText;
  return label;
}

function createStatus(initialText: string, id?: string): HTMLElement {
  const status = document.createElement("p");

  status.className = "join-status";
  if (id !== undefined) {
    status.id = id;
  }
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.dataset.state = "idle";
  status.textContent = initialText;
  return status;
}

function updateStatus(status: HTMLElement, state: "idle" | "pending" | "error" | "success", text: string): void {
  status.dataset.state = state;
  status.textContent = text;
}

function associateValidationStatus(control: HTMLElement, statusId: string): void {
  control.setAttribute("aria-describedby", statusId);
  control.setAttribute("aria-errormessage", statusId);
  control.setAttribute("aria-invalid", "false");
}

function setControlInvalid(control: HTMLElement, invalid: boolean): void {
  control.setAttribute("aria-invalid", invalid ? "true" : "false");
}

function createModuleHeader(
  sequence: string,
  eyebrowText: string,
  titleText: string,
  descriptionText: string,
): { readonly header: HTMLElement; readonly titleId: string } {
  const header = document.createElement("header");
  const eyebrow = document.createElement("p");
  const title = document.createElement("h2");
  const description = document.createElement("p");
  const titleId = `${sequence}-title`;

  header.className = "join-module-header";
  eyebrow.className = "join-module-eyebrow";
  eyebrow.textContent = eyebrowText;
  title.id = titleId;
  title.textContent = titleText;
  description.className = "join-module-description";
  description.textContent = descriptionText;
  header.append(eyebrow, title, description);

  return { header, titleId };
}

function renderHumanInvitationModule(
  sequence: string,
  roomId: string,
  callback: unknown,
): HTMLElement {
  const module = document.createElement("section");
  const { header, titleId } = createModuleHeader(
    `${sequence}-human`,
    "真人成员",
    "邀请加入房间",
    "受邀者必须接受或拒绝；发送后将等待对方接受。",
  );
  const form = document.createElement("form");
  const actorInput = document.createElement("input");
  const actorLabel = createLabel("成员 ID", actorInput);
  const hint = document.createElement("p");
  const button = document.createElement("button");
  const status = createStatus("输入成员 ID 后发送邀请。", `${sequence}-human-status`);

  module.className = "join-module join-module--human";
  module.dataset.joinKind = "human-invitation";
  module.setAttribute("aria-labelledby", titleId);
  form.className = "join-form join-form--human";
  form.noValidate = true;
  actorInput.id = `${sequence}-human-actor-id`;
  actorInput.className = "join-control";
  actorInput.name = "inviteeActorId";
  actorInput.type = "text";
  actorInput.required = true;
  actorInput.autocomplete = "off";
  actorInput.setAttribute(
    "aria-describedby",
    `${sequence}-human-hint ${status.id}`,
  );
  actorInput.setAttribute("aria-errormessage", status.id);
  actorInput.setAttribute("aria-invalid", "false");
  actorLabel.htmlFor = actorInput.id;
  hint.id = `${sequence}-human-hint`;
  hint.className = "join-field-hint";
  hint.textContent = "使用对方的公开 Actor ID。";
  button.className = "join-action join-action--human";
  button.type = "submit";
  button.textContent = "邀请真人";

  if (roomId.length === 0 || typeof callback !== "function") {
    button.disabled = true;
    updateStatus(status, "error", "当前房间无法发送邀请，请检查运行参数。");
  }

  actorInput.addEventListener("input", () => {
    if (actorInput.value.trim().length > 0) {
      setControlInvalid(actorInput, false);
      if (status.dataset.state === "error") {
        updateStatus(status, "idle", "成员 ID 已填写，可以发送邀请。");
      }
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const inviteeActorId = actorInput.value.trim();

    if (roomId.length === 0 || typeof callback !== "function") {
      updateStatus(status, "error", "当前房间无法发送邀请，请检查运行参数。");
      return;
    }

    if (inviteeActorId.length === 0) {
      setControlInvalid(actorInput, true);
      updateStatus(status, "error", "请输入有效的成员 ID。");
      actorInput.focus();
      return;
    }

    const request: HumanInvitationRequest = {
      kind: "human-invitation",
      roomId,
      inviteeActorId,
    };

    setControlInvalid(actorInput, false);
    button.disabled = true;
    updateStatus(status, "pending", `正在提交给 ${inviteeActorId} 的邀请；等待 server ACK。`);
    try {
      callback(request);
    } catch {
      button.disabled = false;
      updateStatus(status, "error", "邀请未能提交，请重试。");
    }
  });

  form.append(actorLabel, actorInput, hint, button, status);
  module.append(header, form);
  return module;
}

function renderAgentConfigurationModule(
  sequence: string,
  roomId: string,
  agents: readonly AgentControlOption[],
  callback: unknown,
): HTMLElement {
  const module = document.createElement("section");
  const { header, titleId } = createModuleHeader(
    `${sequence}-agent`,
    "Agent 角色",
    "配置加入房间",
    "无需接受；提交后等待 server ACK 与 stable event，再显示权威生效状态。",
  );
  const form = document.createElement("form");
  const agentSelect = document.createElement("select");
  const agentLabel = createLabel("Agent", agentSelect);
  const participationSelect = document.createElement("select");
  const participationLabel = createLabel("参与度", participationSelect);
  const permissionFieldset = document.createElement("fieldset");
  const permissionLegend = document.createElement("legend");
  const permissionList = document.createElement("div");
  const button = document.createElement("button");
  const status = createStatus("选择配置项后提交。", `${sequence}-agent-status`);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const configurableAgentCount = agents.filter(
    (agent) => agent.toolPermissions.length > 0,
  ).length;
  const hasValidRuntime = roomId.length > 0 && typeof callback === "function";

  module.className = "join-module join-module--agent";
  module.dataset.joinKind = "agent-configuration";
  module.setAttribute("aria-labelledby", titleId);
  form.className = "join-form join-form--agent";
  form.noValidate = true;
  agentSelect.id = `${sequence}-agent-id`;
  agentSelect.className = "join-control";
  agentSelect.name = "agentId";
  agentSelect.required = true;
  agentLabel.htmlFor = agentSelect.id;
  agentSelect.append(new Option("选择 Agent", ""));
  for (const agent of agents) {
    const hasDeclaredTools = agent.toolPermissions.length > 0;
    const option = new Option(
      hasDeclaredTools ? agent.displayName : `${agent.displayName}（未声明工具，不可配置）`,
      agent.id,
    );

    option.disabled = !hasDeclaredTools;
    agentSelect.append(option);
  }

  participationSelect.id = `${sequence}-participation`;
  participationSelect.className = "join-control";
  participationSelect.name = "participation";
  participationSelect.required = true;
  participationLabel.htmlFor = participationSelect.id;
  participationSelect.append(new Option("选择参与度", ""));
  for (const [value, label] of agentParticipationLabels) {
    participationSelect.append(new Option(label, value));
  }

  permissionFieldset.className = "join-permission-fieldset";
  permissionLegend.textContent = "工具权限";
  permissionList.className = "join-permission-list";
  permissionList.textContent = "请先选择 Agent。";
  permissionFieldset.append(permissionLegend, permissionList);
  for (const control of [agentSelect, participationSelect, permissionFieldset]) {
    associateValidationStatus(control, status.id);
  }
  button.className = "join-action join-action--agent";
  button.type = "submit";
  button.textContent = "配置 Agent";

  const renderPermissions = (agent: AgentControlOption | undefined): void => {
    permissionList.replaceChildren();

    if (agent === undefined) {
      permissionList.textContent = "请先选择 Agent。";
      return;
    }

    if (agent.toolPermissions.length === 0) {
      permissionList.textContent = "此 Agent 没有已声明的工具权限，无法配置。";
      return;
    }

    for (const [index, permission] of agent.toolPermissions.entries()) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      const labelText = document.createElement("span");

      label.className = "join-permission-option";
      checkbox.id = `${sequence}-permission-${index}`;
      checkbox.name = "toolPermissions";
      checkbox.type = "checkbox";
      checkbox.value = permission;
      labelText.textContent = permission;
      label.append(checkbox, labelText);
      permissionList.append(label);
    }
  };

  if (agents.length === 0) {
    agentSelect.disabled = true;
    participationSelect.disabled = true;
    permissionFieldset.disabled = true;
    button.disabled = true;
    permissionList.textContent = "没有可配置的 Agent，请检查可用 Agent 数据。";
    updateStatus(status, "error", "没有可配置的 Agent。");
  } else if (configurableAgentCount === 0) {
    participationSelect.disabled = true;
    permissionFieldset.disabled = true;
    button.disabled = true;
    permissionList.textContent = "这些 Agent 均未声明工具权限，无法配置。";
    updateStatus(status, "error", "所有 Agent 均未声明工具权限，无法配置。");
  } else if (!hasValidRuntime) {
    button.disabled = true;
    updateStatus(status, "error", "当前房间无法配置 Agent，请检查运行参数。");
  }

  agentSelect.addEventListener("change", () => {
    const selectedAgent = agentsById.get(agentSelect.value);

    renderPermissions(selectedAgent);
    setControlInvalid(permissionFieldset, false);
    if (selectedAgent === undefined) {
      const hasInvalidSelection = agentSelect.value.length > 0;

      setControlInvalid(agentSelect, hasInvalidSelection);
      participationSelect.disabled = configurableAgentCount === 0;
      button.disabled = configurableAgentCount === 0 || !hasValidRuntime || hasInvalidSelection;
      updateStatus(
        status,
        hasInvalidSelection ? "error" : "idle",
        "请选择有效的 Agent。",
      );
    } else if (selectedAgent.toolPermissions.length === 0) {
      setControlInvalid(agentSelect, true);
      participationSelect.disabled = true;
      button.disabled = true;
      updateStatus(status, "error", "此 Agent 没有已声明的工具权限，无法配置。");
    } else {
      setControlInvalid(agentSelect, false);
      participationSelect.disabled = configurableAgentCount === 0;
      button.disabled = configurableAgentCount === 0 || !hasValidRuntime;
      updateStatus(
        status,
        "idle",
        selectedAgent === undefined ? "请选择有效的 Agent。" : "选择参与度与工具权限后提交。",
      );
    }
  });

  participationSelect.addEventListener("change", () => {
    if (agentParticipationValues.has(participationSelect.value as AgentParticipation)) {
      setControlInvalid(participationSelect, false);
    }
  });

  permissionList.addEventListener("change", () => {
    const agent = agentsById.get(agentSelect.value);
    const selectedPermissions = Array.from(
      permissionList.querySelectorAll<HTMLInputElement>("input[name='toolPermissions']:checked"),
      (input) => input.value,
    );
    const isValidCorrection =
      agent !== undefined &&
      selectedPermissions.length > 0 &&
      new Set(selectedPermissions).size === selectedPermissions.length &&
      selectedPermissions.every((permission) => agent.toolPermissions.includes(permission));

    if (isValidCorrection) {
      setControlInvalid(permissionFieldset, false);
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (roomId.length === 0 || typeof callback !== "function") {
      updateStatus(status, "error", "当前房间无法配置 Agent，请检查运行参数。");
      return;
    }

    const agent = agentsById.get(agentSelect.value);
    if (agent === undefined) {
      setControlInvalid(agentSelect, true);
      updateStatus(status, "error", "请选择有效的 Agent。");
      agentSelect.focus();
      return;
    }

    if (agent.toolPermissions.length === 0) {
      setControlInvalid(agentSelect, true);
      renderPermissions(agent);
      participationSelect.disabled = true;
      button.disabled = true;
      updateStatus(status, "error", "此 Agent 没有已声明的工具权限，无法配置。");
      return;
    }
    setControlInvalid(agentSelect, false);

    const participationValue = participationSelect.value;
    if (!agentParticipationValues.has(participationValue as AgentParticipation)) {
      setControlInvalid(participationSelect, true);
      updateStatus(status, "error", "请选择参与度。");
      participationSelect.focus();
      return;
    }
    const participation = participationValue as AgentParticipation;
    setControlInvalid(participationSelect, false);
    const selectedPermissions = Array.from(
      permissionList.querySelectorAll<HTMLInputElement>("input[name='toolPermissions']:checked"),
      (input) => input.value,
    );
    const hasOnlyDeclaredPermissions =
      new Set(selectedPermissions).size === selectedPermissions.length &&
      selectedPermissions.every((permission) => agent.toolPermissions.includes(permission));

    if (!hasOnlyDeclaredPermissions) {
      setControlInvalid(permissionFieldset, true);
      updateStatus(status, "error", "工具权限已失效，请重新选择。");
      renderPermissions(agent);
      return;
    }

    if (selectedPermissions.length === 0) {
      setControlInvalid(permissionFieldset, true);
      updateStatus(status, "error", "请至少选择一项工具权限。");
      permissionList.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }

    const request: AgentConfigurationRequest = {
      kind: "agent-configuration",
      roomId,
      agentId: agent.id,
      participation,
      toolPermissions: selectedPermissions,
    };

    setControlInvalid(permissionFieldset, false);
    button.disabled = true;
    updateStatus(status, "pending", `正在提交 ${agent.displayName} 的配置；等待 server ACK / stable event。`);
    try {
      callback(request);
    } catch {
      button.disabled = false;
      updateStatus(status, "error", "Agent 配置未能提交，请重试。");
    }
  });

  form.append(
    agentLabel,
    agentSelect,
    participationLabel,
    participationSelect,
    permissionFieldset,
    button,
    status,
  );
  module.append(header, form);
  return module;
}

export function renderRoomJoinControls(root: HTMLElement, options: RoomJoinControlOptions): void {
  roomJoinControlSequence += 1;
  const sequence = `room-join-${roomJoinControlSequence}`;
  const roomId = typeof options?.roomId === "string" ? options.roomId.trim() : "";
  const agents = normaliseAgents(options?.agents);
  const controls = document.createElement("section");

  controls.className = "room-join-controls";
  controls.dataset.testid = "room-join-controls";
  controls.setAttribute("aria-label", "添加房间参与者");
  controls.append(
    renderHumanInvitationModule(sequence, roomId, options?.onInviteHuman),
    renderAgentConfigurationModule(sequence, roomId, agents, options?.onConfigureAgent),
  );
  root.replaceChildren(controls);
}

export function renderRoomJoinReview(root: HTMLElement): void {
  const review = document.createElement("section");
  const header = document.createElement("header");
  const eyebrow = document.createElement("p");
  const heading = document.createElement("h1");
  const description = document.createElement("p");
  const controlsRoot = document.createElement("div");
  const callbackStatus = createStatus("预览就绪：提交任一表单可检查隔离后的回调载荷。");
  const previewAgents: readonly AgentActor[] = [
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
      toolPermissions: ["deploy", "logs.read"],
    },
  ];

  review.className = "join-review";
  eyebrow.className = "join-review__eyebrow";
  eyebrow.textContent = "ROOM / JOIN REVIEW";
  heading.textContent = "添加房间参与者";
  description.textContent = "真人邀请与 Agent 配置是两条不同的加入路径。";
  callbackStatus.classList.add("join-review__callback-status");
  header.append(eyebrow, heading, description);
  renderRoomJoinControls(controlsRoot, {
    roomId: "room-product-review",
    agents: previewAgents,
    onInviteHuman: (request) => {
      updateStatus(
        callbackStatus,
        "success",
        `已捕获真人邀请：${request.inviteeActorId}，等待对方接受。`,
      );
    },
    onConfigureAgent: (request) => {
      const permissions =
        request.toolPermissions.length === 0 ? "无工具" : request.toolPermissions.join("、");
      updateStatus(
        callbackStatus,
        "success",
        `已捕获 Agent 配置：${request.agentId} · ${request.participation} · ${permissions}。`,
      );
    },
  });
  review.append(header, controlsRoot, callbackStatus);
  root.dataset.testid = "room-join-review";
  root.setAttribute("aria-label", "添加房间参与者");
  root.replaceChildren(review);
}

function primitiveElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function appendPrimitiveButton(parent: HTMLElement, label: string, action: string): HTMLButtonElement {
  const button = primitiveElement("button", "primitive-action", label);
  button.type = "button";
  button.dataset.action = action;
  parent.append(button);
  return button;
}

function appendReceiptRecords(
  messagesById: ReadonlyMap<string, HTMLElement>,
  records: RestoredPrimitivePreviewRecords,
): void {
  for (const record of records.humanReads) {
    const humanRead = primitiveElement(
      "div",
      "human-read-receipt",
      `✓✓ 已读：${record.readerId}`,
    );
    humanRead.dataset.receiptKind = "human-read";
    humanRead.dataset.messageId = record.messageId;
    messagesById.get(record.messageId)!.append(humanRead);
  }

  const outcomeLabels: Readonly<Record<AgentJudgement["outcome"], string>> = {
    no_response_needed: "无需回应",
    will_respond: "将回应",
    suppressed: "被抑制",
  };
  for (const record of records.agentJudgements) {
    const judgement = primitiveElement(
      "div",
      "agent-judgement",
      `已判定 · ${outcomeLabels[record.outcome]} · ${record.reason}`,
    );
    judgement.dataset.receiptKind = "agent-judgement";
    judgement.dataset.messageId = record.messageId;
    const content = messagesById.get(record.messageId)!
      .querySelector<HTMLElement>(".message-content");
    if (content === null) throw new Error("Message judgement target has no content column");
    content.append(judgement);
  }

  const routeOutcomeLabels: Readonly<Record<RouteJudgment["outcome"], string>> = {
    no_response_needed: "无需回应",
    will_respond: "将回应",
    suppressed: "被抑制",
  };
  for (const record of records.routeJudgments) {
    const judgment = primitiveElement(
      "div",
      "route-judgment",
      `路由判定 · ${routeOutcomeLabels[record.outcome]} · ${record.reasonText}`,
    );
    judgment.dataset.routeOutcome = record.outcome;
    judgment.dataset.routeReasonCode = record.reasonCode;
    judgment.dataset.routeAttempt = String(record.routeAttempt);
    judgment.dataset.routeJobId = record.routeJobId;
    const content = messagesById.get(record.sourceMessageId)!
      .querySelector<HTMLElement>(".message-content");
    if (content === null) throw new Error("Route judgment target has no content column");
    content.append(judgment);
  }
}

function appendAddressingPreview(
  container: HTMLElement,
  records: RestoredPrimitivePreviewRecords,
): void {
  const section = primitiveElement("section", "addressing-preview");
  const humanLine = primitiveElement("p", "addressing-line");
  const humanMention = primitiveElement("span", "mention mention--human", "@周安全");
  const agentLine = primitiveElement("p", "addressing-line");
  const agentMention = primitiveElement("span", "mention mention--agent", "@数据 Agent");
  const audience = primitiveElement("p", "audience-addressing", "@all 只调用 Agent · @here 仅群主可用且有频率限制");

  humanLine.append(humanMention, document.createTextNode(" 请确认权限边界（请求，可搁置、可转交）"));
  agentLine.append(agentMention, document.createTextNode(" 拉取失败记录（调用，必响应、可中断）"));
  section.append(humanLine, agentLine);
  const openStatusLabels: Readonly<Record<OpenItem["status"], string>> = {
    awaiting: "待回应",
    answered: "已回应",
    deferred: "已搁置",
    transferred: "已转交",
  };
  for (const record of records.openItems) {
    const originLabel = record.origin.kind === "human_mention"
      ? "@human 请求"
      : record.origin.kind === "manual_unfinished"
        ? "手动标记未完"
        : `Agent ${record.origin.proposalKind} proposal · ${record.origin.sourceExecutionId}`;
    const openItem = primitiveElement(
      "div",
      "open-item",
      `待答项 · ${record.content} · ${record.requesterId} → ${record.currentOwnerId ?? "已闭合"} · ${openStatusLabels[record.status]}`,
    );
    openItem.dataset.openItemStatus = record.status;
    openItem.dataset.openItemOrigin = record.origin.kind;
    openItem.dataset.sourceMessageId = record.sourceMessageId;
    openItem.append(primitiveElement(
      "span", "open-item__source", `来源：${originLabel} · 消息 ${record.sourceMessageId}`,
    ));
    if (record.status === "awaiting" || record.status === "transferred") {
      const actions = primitiveElement("span", "open-item__actions");
      for (const [label, action] of [
        ["回应", "answer"], ["搁置", "defer"], ["转交", "transfer"],
      ] as const) {
        appendPrimitiveButton(actions, label, action).classList.add("human-request-action");
      }
      openItem.append(actions);
    }
    section.append(openItem);
  }
  const lightTaskStatusLabels: Readonly<Record<LightTask["status"], string>> = {
    todo: "待认领",
    claimed: "已认领",
    delivered: "待验收",
    verified: "已验收",
  };
  for (const record of records.lightTasks) {
    const lightTask = primitiveElement(
      "article",
      "light-task",
      `轻任务 · ${record.title} · ${lightTaskStatusLabels[record.status]}`,
    );
    lightTask.dataset.lightTaskStatus = record.status;
    lightTask.dataset.sourceMessageId = record.sourceMessageId;
    lightTask.append(
      primitiveElement("span", "light-task__claimant", `认领人：${record.claimant ?? "未认领"}`),
      primitiveElement(
        "span",
        "light-task__verifier",
        `验收角色：${record.verifierRole} · 验收人：${record.verifierActorId ?? "交付时解析"}`,
      ),
      primitiveElement("span", "light-task__source", `来源消息：${record.sourceMessageId}`),
    );
    const criteria = primitiveElement("ul", "light-task__criteria");
    if (record.criteria.length === 0) {
      criteria.append(primitiveElement("li", "light-task__criterion", "无预设 criteria · 验收需显式确认"));
    } else {
      for (const criterion of record.criteria) {
        const item = primitiveElement(
          "li", "light-task__criterion", `${criterion.met ? "✓" : "○"} ${criterion.text}`,
        );
        item.dataset.criterionMet = String(criterion.met);
        criteria.append(item);
      }
    }
    lightTask.append(criteria);
    section.append(lightTask);
  }
  const executionStatusLabels: Readonly<Record<AgentExecution["status"], string>> = {
    accepted: "已接受",
    running: "正在调用",
    completed: "已完成调用",
    failed: "调用失败",
    cancelled: "已取消",
  };
  const executionPhaseLabels: Readonly<Record<AgentExecution["phase"], string>> = {
    queued: "排队中",
    retry_scheduled: "等待重试",
    recovery_queued: "等待恢复",
    awaiting_capacity: "等待容量",
    claiming: "正在领取",
    snapshot_frozen: "上下文已冻结",
    model_generation: "正在生成",
    read_tool: "正在读取",
    waiting_confirmation: "等待确认",
    side_effect_claimed: "副作用已领取",
    final_committing: "正在提交结果",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  for (const record of records.agentExecutions) {
    const agentLabel = record.agentId === "agent-data" ? "数据 Agent" : record.agentId;
    const retried = record.retryOfExecutionId !== undefined;
    const executionState = executionStatusLabels[record.status];
    const invocation = primitiveElement(
      "div",
      "agent-invocation",
      `Agent 执行 #${record.executionOrdinal} · ${agentLabel} ${executionState} · ${executionPhaseLabels[record.phase]} · attempt ${record.currentAttemptSeq}`,
    );
    invocation.dataset.agentInvocation = record.agentId;
    invocation.dataset.executionId = record.executionId;
    invocation.dataset.executionStatus = record.status;
    invocation.dataset.executionPhase = record.phase;
    if (retried) {
      invocation.classList.add("agent-invocation--requeued");
      invocation.dataset.retryOfExecutionId = record.retryOfExecutionId;
    }
    const status = primitiveElement(
      "span",
      "member-status-label",
      record.status === "running" ? "执行中" : "可用",
    );
    status.dataset.memberId = record.agentId;
    if (record.status === "running") {
      const cancel = appendPrimitiveButton(invocation, "取消（预览不可用）", "cancel");
      cancel.dataset.testid = "cancel-agent-execution";
      cancel.disabled = true;
      cancel.title = "取消只在已连接并取得权威 execution version 后可用";
    }
    section.append(invocation, status);
  }
  section.append(audience);
  container.append(section);
}

function appendReactionAndCorrectionPreview(
  container: HTMLElement,
  records: RestoredPrimitivePreviewRecords,
): void {
  const correction = primitiveElement(
    "aside",
    "agent-correction",
    "更正 · 复核后为 36 条，其中 2 条重复计数。原消息保留不变，更正追加在后",
  );
  correction.dataset.correctionFor = "preview-agent-data";
  container.append(correction);
  for (const record of records.socialReactions) {
    const social = primitiveElement(
      "span",
      "reaction reaction--social",
      `${record.emoji} 纯社交`,
    );
    social.dataset.reactionKind = "social";
    social.dataset.sourceMessageId = record.sourceMessageId;
    container.append(social);
  }
  for (const record of records.calibrations) {
    const marker = "emoji" in record
      ? record.emoji
      : record.feedback === "useful" ? "有用" : "这条不必";
    const calibration = primitiveElement(
      "span",
      "reaction reaction--calibration",
      `${marker} 校准：影响后续发言判定`,
    );
    calibration.dataset.reactionKind = "calibration";
    calibration.dataset.sourceMessageId = record.sourceMessageId;
    container.append(calibration);
  }
}

const defaultRestoredPrimitiveRecords: RestoredPrimitivePreviewRecords = {
  humanReads: [{
    id: "preview-human-read",
    messageId: "preview-agent-data",
    readerId: "周安全、陈研发",
    readAt: "2026-08-08T10:02:00.000Z",
  }],
  agentJudgements: [
    {
      id: "preview-agent-judgement-no-response",
      messageId: "preview-human-mention",
      agentId: "agent-data",
      outcome: "no_response_needed",
      reason: "未命中我的领域",
      decidedAt: "2026-08-08T10:02:01.000Z",
    },
    {
      id: "preview-agent-judgement-will-respond",
      messageId: "preview-human-mention",
      agentId: "agent-data",
      outcome: "will_respond",
      reason: "命中领域，准备回应",
      decidedAt: "2026-08-08T10:02:02.000Z",
    },
    {
      id: "preview-agent-judgement-suppressed",
      messageId: "preview-human-mention",
      agentId: "agent-data",
      outcome: "suppressed",
      reason: "同话题冷却期内，还剩 7 分钟",
      decidedAt: "2026-08-08T10:02:03.000Z",
    },
  ],
  routeJudgments: [{
    id: "preview-route-judgment",
    routeJobId: "preview-route-job",
    sourceMessageId: "preview-human-mention",
    agentId: "agent-data",
    outcome: "will_respond",
    reasonCode: "direct_mention",
    reasonText: "显式点名，路由到数据 Agent",
    routeAttempt: 1,
    decidedAt: "2026-08-08T10:02:04.000Z",
  }],
  openItems: [{
    id: "preview-open-item",
    roomId: "preview-room",
    sourceMessageId: "preview-agent-data",
    requesterId: "周安全",
    currentOwnerId: "陈研发",
    content: "权限边界",
    status: "transferred",
    origin: { kind: "manual_unfinished" },
    createdAt: "2026-08-08T10:03:00.000Z",
    transferChain: [{
      fromId: "周安全",
      toId: "陈研发",
      reason: "转交领域负责人",
      transferredAt: "2026-08-08T10:03:01.000Z",
    }],
  }],
  lightTasks: [{
    id: "preview-light-task",
    roomId: "preview-room",
    sourceMessageId: "preview-human-mention",
    title: "完成权限边界复核",
    claimant: "陈研发",
    claimantRoleAtClaim: "member",
    verifierRole: "owner",
    verifierActorId: "周安全",
    criteria: [{ id: "preview-criterion", text: "权限矩阵已复核", met: false }],
    status: "delivered",
    createdAt: "2026-08-08T10:03:10.000Z",
    claimedAt: "2026-08-08T10:03:20.000Z",
    deliveredAt: "2026-08-08T10:03:30.000Z",
  }],
  agentExecutions: [{
    executionId: "preview-agent-execution",
    intentId: "preview-agent-intent",
    lineageId: "preview-agent-lineage",
    executionOrdinal: 1,
    roomId: "preview-room",
    agentId: "agent-data",
    snapshotId: "preview-context-snapshot",
    providerId: "openai",
    modelId: "gpt-5",
    status: "running",
    phase: "waiting_confirmation",
    currentAttemptSeq: 1,
    version: 2,
    queuedAt: "2026-08-08T10:03:59.000Z",
    startedAt: "2026-08-08T10:04:00.000Z",
    updatedAt: "2026-08-08T10:04:00.000Z",
  }],
  socialReactions: [{
    id: "preview-social-reaction",
    sourceMessageId: "preview-human-mention",
    actorId: "human-li",
    emoji: "👍",
    createdAt: "2026-08-08T10:05:00.000Z",
  }],
  calibrations: [{
    id: "preview-calibration",
    sourceMessageId: "preview-agent-data",
    actorId: "human-li",
    agentId: "agent-data",
    emoji: "👎",
    createdAt: "2026-08-08T10:05:01.000Z",
  }],
};

function validateRestoredPrimitiveRecords(records: RestoredPrimitivePreviewRecords): void {
  if (typeof records !== "object" || records === null ||
      Object.keys(records).sort().join(",") !== [
        "agentExecutions", "agentJudgements", "calibrations", "humanReads",
        "lightTasks", "openItems", "routeJudgments", "socialReactions",
      ].join(",") ||
      !Array.isArray(records.humanReads) || !Array.isArray(records.agentJudgements) ||
      !Array.isArray(records.routeJudgments) ||
      !Array.isArray(records.openItems) || !Array.isArray(records.lightTasks) ||
      !Array.isArray(records.agentExecutions) ||
      !Array.isArray(records.socialReactions) || !Array.isArray(records.calibrations)) {
    throw new TypeError("Restored collaboration record envelope is not closed");
  }
  const messageIds = new Set(["preview-human-mention", "preview-agent-data"]);
  const primitiveIds = [
    ...records.humanReads, ...records.agentJudgements, ...records.routeJudgments,
    ...records.openItems, ...records.lightTasks,
    ...records.socialReactions, ...records.calibrations,
  ].map((record) => record.id);
  primitiveIds.push(...records.agentExecutions.map((record) => record.executionId));
  if (new Set(primitiveIds).size !== primitiveIds.length) {
    throw new TypeError("Restored collaboration records contain duplicate IDs");
  }
  if (!records.humanReads.every((record) =>
    isHumanReadReceipt(record) && messageIds.has(record.messageId)) ||
      !records.agentJudgements.every((record) =>
        isAgentJudgement(record) && messageIds.has(record.messageId)) ||
      !records.routeJudgments.every((record) =>
        isRouteJudgment(record) && messageIds.has(record.sourceMessageId)) ||
      !records.openItems.every((record) =>
        isOpenItem(record) && record.roomId === "preview-room" &&
        messageIds.has(record.sourceMessageId)) ||
      !records.lightTasks.every((record) =>
        isLightTask(record) && record.roomId === "preview-room" &&
        messageIds.has(record.sourceMessageId)) ||
      !records.agentExecutions.every((record) =>
        isAgentExecution(record) && record.roomId === "preview-room") ||
      !records.socialReactions.every((record) =>
        isSocialReaction(record) && messageIds.has(record.sourceMessageId)) ||
      !records.calibrations.every((record) =>
        isCalibrationSignal(record) && record.sourceMessageId === "preview-agent-data")) {
    throw new TypeError("Restored collaboration records are invalid or unrelated to the preview");
  }
}

export function renderM2PrimitivesPreview(
  root: HTMLElement,
  restored: RestoredPrimitivePreviewRecords = defaultRestoredPrimitiveRecords,
): void {
  validateRestoredPrimitiveRecords(restored);
  const preview = primitiveElement("main", "m2-primitives-preview");
  const heading = primitiveElement("h1", undefined, "原生人机协作 IM · 已验收原语预览");
  const timelineRoot = primitiveElement("div", "m2-primitives-timeline");
  const messages: readonly Message[] = [
    {
      id: "preview-human-mention",
      roomId: "preview-room",
      authorId: "human-li",
      authorKind: "human",
      body: "请周安全确认权限边界。",
      sentAt: "2026-08-08T10:00:00.000Z",
    },
    {
      id: "preview-agent-data",
      roomId: "preview-room",
      authorId: "agent-data",
      authorKind: "agent",
      body: "归因完成：50 条中 38 条属召回问题。",
      sentAt: "2026-08-08T10:01:00.000Z",
    },
  ];
  const actorsById = new Map<string, Actor>([
    ["human-li", { id: "human-li", kind: "human", displayName: "李乐", reachability: "online" }],
    [
      "agent-data",
      {
        id: "agent-data",
        kind: "agent",
        displayName: "数据 Agent",
        readiness: "busy",
        toolPermissions: ["warehouse.query"],
      },
    ],
  ]);

  renderMessageTimeline(timelineRoot, messages, actorsById);
  const messageArticles = timelineRoot.querySelectorAll<HTMLElement>("[data-message-id]");
  const messagesById = new Map<string, HTMLElement>();
  for (const article of messageArticles) {
    const messageId = article.dataset.messageId;
    if (messageId === undefined || messagesById.has(messageId)) {
      throw new TypeError("Primitive preview requires unique message targets");
    }
    messagesById.set(messageId, article);
  }
  const humanMessage = messagesById.get("preview-human-mention");
  const agentMessage = messagesById.get("preview-agent-data");
  if (humanMessage === undefined || agentMessage === undefined) {
    throw new Error("Primitive preview requires both message forms.");
  }
  const humanActions = primitiveElement("div", "message-actions message-actions--human");
  appendPrimitiveButton(humanActions, "编辑", "edit");
  appendPrimitiveButton(humanActions, "撤回", "recall");
  humanMessage.append(humanActions);
  appendReceiptRecords(messagesById, restored);
  appendAddressingPreview(timelineRoot, restored);
  appendReactionAndCorrectionPreview(timelineRoot, restored);
  preview.append(heading, timelineRoot);
  root.dataset.testid = "m2-primitives-review";
  root.setAttribute("aria-label", "已验收人机协作原语预览");
  root.replaceChildren(preview);
}
