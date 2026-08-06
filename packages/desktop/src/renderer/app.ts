import type { Actor, Message } from "@native-im/core";

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

const agentRoleColours = [
  "#2563eb",
  "#7c3aed",
  "#c2410c",
  "#0f766e",
  "#be123c",
  "#4338ca",
  "#9f1239",
];

function initialFor(displayName: string): string {
  return displayName.trim().slice(0, 1).toUpperCase() || "?";
}

function roleColourFor(roleLabel: string): string {
  let total = 0;

  for (const character of roleLabel) {
    total = (total * 31 + character.charCodeAt(0)) >>> 0;
  }

  return agentRoleColours[total % agentRoleColours.length] ?? agentRoleColours[0]!;
}

function actorForMessage(message: Message, actor: Actor | undefined): Actor | undefined {
  return actor?.id === message.authorId && actor.kind === message.authorKind ? actor : undefined;
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

function renderHumanMessage(message: Message, actor: Actor | undefined): HTMLElement {
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

function renderAgentMessage(message: Message, actor: Actor | undefined): HTMLElement {
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
  article.style.setProperty("--message-role-colour", roleColourFor(roleLabel));
  rail.className = "message-role-rail";
  rail.setAttribute("aria-hidden", "true");
  avatar.className = "message-avatar message-avatar--agent";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = initialFor(displayName);
  content.className = "message-content";
  body.className = "message-agent-body";
  body.textContent = message.body;

  appendMessageHeader(content, displayName, message, roleLabel);
  content.append(body);
  article.append(rail, avatar, content);
  return article;
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

  timeline.className = "message-timeline";
  timeline.dataset.testid = "message-timeline";
  timeline.setAttribute("aria-label", "群聊消息");

  for (const message of messages) {
    const actor = actorForMessage(message, actorsById.get(message.authorId));
    const rendered = message.authorKind === "human"
      ? renderHumanMessage(message, actor)
      : renderAgentMessage(message, actor);

    timeline.append(rendered);
  }

  root.replaceChildren(timeline);
}
