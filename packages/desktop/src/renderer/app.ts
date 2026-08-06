import type { Actor, AgentActor, HumanActor, Message } from "@native-im/core";

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
