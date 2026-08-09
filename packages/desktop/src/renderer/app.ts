import type {
  Actor,
  AgentActor,
  AgentConfigurationRequest,
  AgentParticipation,
  HumanActor,
  HumanInvitationRequest,
  Message,
} from "@native-im/core";

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
  ["silent", "静默待命"],
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

function createStatus(initialText: string): HTMLElement {
  const status = document.createElement("p");

  status.className = "join-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.dataset.state = "idle";
  status.textContent = initialText;
  return status;
}

function updateStatus(status: HTMLElement, state: "idle" | "error" | "success", text: string): void {
  status.dataset.state = state;
  status.textContent = text;
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
  const status = createStatus("输入成员 ID 后发送邀请。");

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
  actorInput.setAttribute("aria-describedby", `${sequence}-human-hint`);
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

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const inviteeActorId = actorInput.value.trim();

    if (roomId.length === 0 || typeof callback !== "function") {
      updateStatus(status, "error", "当前房间无法发送邀请，请检查运行参数。");
      return;
    }

    if (inviteeActorId.length === 0) {
      updateStatus(status, "error", "请输入有效的成员 ID。");
      actorInput.focus();
      return;
    }

    const request: HumanInvitationRequest = {
      kind: "human-invitation",
      roomId,
      inviteeActorId,
    };

    try {
      callback(request);
      updateStatus(status, "success", `邀请已发送给 ${inviteeActorId}，等待对方接受。`);
    } catch {
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
    "配置提交后立即生效，无需接受。请选择参与度与工具权限。",
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
  const status = createStatus("选择配置项后提交。");
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

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
    agentSelect.append(new Option(agent.displayName, agent.id));
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
      permissionList.textContent = "此 Agent 无需工具权限。";
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
  } else if (roomId.length === 0 || typeof callback !== "function") {
    button.disabled = true;
    updateStatus(status, "error", "当前房间无法配置 Agent，请检查运行参数。");
  }

  agentSelect.addEventListener("change", () => {
    const selectedAgent = agentsById.get(agentSelect.value);

    renderPermissions(selectedAgent);
    updateStatus(
      status,
      "idle",
      selectedAgent === undefined ? "请选择有效的 Agent。" : "选择参与度与工具权限后提交。",
    );
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (roomId.length === 0 || typeof callback !== "function") {
      updateStatus(status, "error", "当前房间无法配置 Agent，请检查运行参数。");
      return;
    }

    const agent = agentsById.get(agentSelect.value);
    if (agent === undefined) {
      updateStatus(status, "error", "请选择有效的 Agent。");
      agentSelect.focus();
      return;
    }

    const participationValue = participationSelect.value;
    if (!agentParticipationValues.has(participationValue as AgentParticipation)) {
      updateStatus(status, "error", "请选择参与度。");
      participationSelect.focus();
      return;
    }
    const participation = participationValue as AgentParticipation;
    const selectedPermissions = Array.from(
      permissionList.querySelectorAll<HTMLInputElement>("input[name='toolPermissions']:checked"),
      (input) => input.value,
    );
    const hasOnlyDeclaredPermissions =
      new Set(selectedPermissions).size === selectedPermissions.length &&
      selectedPermissions.every((permission) => agent.toolPermissions.includes(permission));

    if (!hasOnlyDeclaredPermissions) {
      updateStatus(status, "error", "工具权限已失效，请重新选择。");
      renderPermissions(agent);
      return;
    }

    if (agent.toolPermissions.length > 0 && selectedPermissions.length === 0) {
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

    try {
      callback(request);
      updateStatus(status, "success", `${agent.displayName} 的配置已提交并立即生效。`);
    } catch {
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
  root.replaceChildren(review);
}
