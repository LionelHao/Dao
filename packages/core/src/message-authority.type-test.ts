import type {
  ActiveHumanMessage,
  AgentFinalMessage,
  HumanMessageSubmit,
  MentionTarget,
  MessageRevision,
  MessageTombstone,
} from "./message-authority.js";

declare const publicDraft: HumanMessageSubmit;

// @ts-expect-error A public Human submit cannot choose an Agent author.
const forgedAuthor: HumanMessageSubmit = { ...publicDraft, authorKind: "agent" };

// @ts-expect-error actorId is server authority, not a public command field.
const injectedActor: HumanMessageSubmit = { ...publicDraft, actorId: "agent-1" };

// @ts-expect-error capabilities cannot cross the public serializable boundary.
const injectedCapability: HumanMessageSubmit = { ...publicDraft, capability: "forged" };

// @ts-expect-error runtime invocation kinds are server-owned and not message input.
const injectedRuntimeKind: HumanMessageSubmit = { ...publicDraft, runtimeKind: "direct_mention" };

const invalidMention: MentionTarget = {
  id: "target-1",
  kind: "human-request",
  targetActorId: "human-2",
  range: { startUtf16: 0, endUtf16: 2 },
  // @ts-expect-error Mention discriminants do not carry runtime intent IDs.
  invocationIntentId: "injected",
};

// @ts-expect-error A tombstone has no operational body for memory or renderer caches.
const leakedBody: string = ({} as MessageTombstone).body;

// @ts-expect-error A tombstone has no operational structured mentions.
const leakedTargets: readonly MentionTarget[] = ({} as MessageTombstone).mentionedTargets;

// @ts-expect-error Agent final messages are immutable and not active Human messages.
const editableAgentFinal: ActiveHumanMessage = {} as AgentFinalMessage;

const agentWithMention: AgentFinalMessage = {
  id: "message-agent",
  roomId: "room-1",
  authorId: "agent-1",
  authorKind: "agent",
  createdAt: "2026-08-19T01:02:03.004Z",
  lifecycle: "active",
  finalBody: "Final",
  sourceInvocationIntentId: "intent-1",
  sourceExecutionId: "execution-1",
  citations: [],
  // @ts-expect-error Agent final creation does not have public mention capability.
  mentionedTargets: [],
};

// @ts-expect-error Revision audit records and operational tombstones are disjoint.
const revisionAsTombstone: MessageTombstone = {} as MessageRevision;

void forgedAuthor;
void injectedActor;
void injectedCapability;
void injectedRuntimeKind;
void invalidMention;
void leakedBody;
void leakedTargets;
void editableAgentFinal;
void agentWithMention;
void revisionAsTombstone;
