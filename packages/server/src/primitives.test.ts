import type { Actor, Message, Room } from "@native-im/core";
import { describe, expect, it } from "vitest";
import { CollaborationPrimitiveError, createCollaborationPrimitives } from "./primitives.js";

const humans: readonly Actor[] = [
  { id: "human-lionel", kind: "human", displayName: "Lionel", reachability: "online" },
  { id: "human-zhou", kind: "human", displayName: "周安全", reachability: "dnd" },
  { id: "human-chen", kind: "human", displayName: "陈研发", reachability: "offline" },
];

const agents: readonly Actor[] = [
  {
    id: "agent-research",
    kind: "agent",
    displayName: "研究 Agent",
    readiness: "busy",
    toolPermissions: ["search.web", "long.running"],
  },
  {
    id: "agent-data",
    kind: "agent",
    displayName: "数据 Agent",
    readiness: "ready",
    toolPermissions: ["warehouse.query"],
  },
  {
    id: "agent-security",
    kind: "agent",
    displayName: "安全 Agent",
    readiness: "paused",
    toolPermissions: ["policy.read"],
  },
  {
    id: "agent-ops",
    kind: "agent",
    displayName: "运维 Agent",
    readiness: "ready",
    toolPermissions: ["deploy.read"],
  },
];

const room: Room = {
  id: "room-native-im",
  name: "原生人机协作 IM",
  memberIds: [...humans, ...agents].map((actor) => actor.id),
  createdAt: "2026-08-07T00:00:00.000Z",
};

const humanMessage: Message = {
  id: "message-human-1",
  roomId: room.id,
  authorId: "human-lionel",
  authorKind: "human",
  body: "@周安全 请确认权限边界。",
  sentAt: "2026-08-07T09:00:00.000Z",
};

const agentMessage: Message = {
  id: "message-agent-1",
  roomId: room.id,
  authorId: "agent-data",
  authorKind: "agent",
  body: "已查到 38 条召回问题。",
  sentAt: "2026-08-07T09:01:00.000Z",
};

function createFixture() {
  const toolCalls: string[] = [];
  const primitives = createCollaborationPrimitives({
    actors: [...humans, ...agents],
    rooms: [room],
    messages: [humanMessage, agentMessage],
    roomOwners: new Map([[room.id, "human-lionel"]]),
    now: () => "2026-08-07T09:02:00.000Z",
    toolInvokers: {
      "search.web": async ({ agentId }) => {
        toolCalls.push(`${agentId}:search.web`);
        return "搜索完成";
      },
      "warehouse.query": async ({ agentId }) => {
        toolCalls.push(`${agentId}:warehouse.query`);
        return "查询完成";
      },
      "policy.read": async ({ agentId }) => {
        toolCalls.push(`${agentId}:policy.read`);
        return "读取完成";
      },
      "deploy.read": async ({ agentId }) => {
        toolCalls.push(`${agentId}:deploy.read`);
        return "读取完成";
      },
      "long.running": async ({ agentId, signal }) => {
        toolCalls.push(`${agentId}:long.running`);
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("interrupted", "AbortError")));
        });
      },
    },
  });

  return { primitives, toolCalls };
}

describe("T-0012 read receipts and agent judgements", () => {
  it("stores human reads separately and records an explainable judgement when an agent will not speak", () => {
    const { primitives } = createFixture();

    primitives.recordHumanRead({ messageId: humanMessage.id, readerId: "human-chen" });
    primitives.evaluateAgentJudgement({
      messageId: humanMessage.id,
      agentId: "agent-data",
      matchesDomain: false,
    });
    primitives.evaluateAgentJudgement({
      messageId: humanMessage.id,
      agentId: "agent-security",
      matchesDomain: true,
      cooldownRemainingMinutes: 7,
    });

    expect(primitives.humanReadReceiptsFor(humanMessage.id)).toMatchObject([
      { readerId: "human-chen", messageId: humanMessage.id },
    ]);
    expect(primitives.agentJudgementsFor(humanMessage.id)).toEqual([
      expect.objectContaining({
        agentId: "agent-data",
        outcome: "no_response_needed",
        reason: "未命中我的领域",
      }),
      expect.objectContaining({
        agentId: "agent-security",
        outcome: "suppressed",
        reason: "同话题冷却期内，还剩 7 分钟",
      }),
    ]);
  });
});

describe("T-0013 request and invocation addressing", () => {
  it("turns a human mention into a transferable open item but an agent mention into an interruptible tool execution", async () => {
    const { primitives, toolCalls } = createFixture();

    const openItem = primitives.addressHuman({
      messageId: humanMessage.id,
      requesterId: "human-lionel",
      targetId: "human-zhou",
      content: "确认权限边界",
    });
    const transferred = primitives.transferOpenItem(openItem.id, "human-chen", "周安全本周不在岗");
    expect(transferred).toMatchObject({
      status: "transferred",
      ownerId: "human-chen",
      transferChain: [expect.objectContaining({ fromId: "human-zhou", toId: "human-chen" })],
    });

    const execution = primitives.addressAgent({
      messageId: humanMessage.id,
      requesterId: "human-lionel",
      targetId: "agent-research",
      toolName: "long.running",
      input: "检索历史",
    });
    expect(primitives.openItemsFor(room.id)).toHaveLength(1);
    expect(execution.status).toBe("running");
    expect(toolCalls).toContain("agent-research:long.running");

    primitives.interruptAgentExecution(execution.id);
    await expect(primitives.waitForAgentExecution(execution.id)).resolves.toMatchObject({ status: "interrupted" });
    expect(primitives.agentReadiness("agent-research")).toBe("ready");
    expect(() => primitives.rejectAgentExecution(execution.id)).toThrowError(
      new CollaborationPrimitiveError("agent_cannot_reject_invocation"),
    );
  });

  it("addresses only agents with @all and only online humans with owner-limited, rate-limited @here", () => {
    const { primitives } = createFixture();

    const all = primitives.addressAll({
      roomId: room.id,
      requesterId: "human-lionel",
      messageId: humanMessage.id,
      toolNameByAgentId: new Map([
        ["agent-research", "search.web"],
        ["agent-data", "warehouse.query"],
        ["agent-security", "policy.read"],
        ["agent-ops", "deploy.read"],
      ]),
      input: "请分别给出观点",
    });
    expect(all.map((execution) => execution.agentId)).toEqual([
      "agent-research",
      "agent-data",
      "agent-security",
      "agent-ops",
    ]);
    expect(primitives.addressHere({ roomId: room.id, requesterId: "human-zhou" })).toEqual({
      ok: false,
      code: "here_requires_room_owner",
    });
    expect(primitives.addressHere({ roomId: room.id, requesterId: "human-lionel" })).toEqual({
      ok: true,
      recipientIds: ["human-lionel"],
    });
    expect(primitives.addressHere({ roomId: room.id, requesterId: "human-lionel" })).toEqual({
      ok: false,
      code: "here_rate_limited",
    });
  });
});

describe("T-0014 message and reaction separation", () => {
  it("edits and recalls human messages but rejects the same API requests for immutable agent records", () => {
    const { primitives } = createFixture();

    expect(primitives.editMessage({ messageId: humanMessage.id, actorId: "human-lionel", body: "修订后的请求" })).toMatchObject({
      body: "修订后的请求",
      edited: true,
    });
    expect(primitives.recallMessage({ messageId: humanMessage.id, actorId: "human-lionel" })).toMatchObject({ recalled: true });
    expect(() => primitives.editMessage({ messageId: agentMessage.id, actorId: "agent-data", body: "篡改" })).toThrowError(
      new CollaborationPrimitiveError("agent_message_immutable"),
    );
    expect(() => primitives.recallMessage({ messageId: agentMessage.id, actorId: "agent-data" })).toThrowError(
      new CollaborationPrimitiveError("agent_message_immutable"),
    );
  });

  it("appends an agent correction and separates social reactions from calibration signals", () => {
    const { primitives } = createFixture();

    const correction = primitives.correctAgentMessage({
      originalMessageId: agentMessage.id,
      agentId: "agent-data",
      body: "复核后为 36 条，其中 2 条重复计数。",
    });
    expect(primitives.messageState(agentMessage.id)).toMatchObject({ body: agentMessage.body, recalled: false });
    expect(primitives.correctionsFor(agentMessage.id)).toEqual([
      expect.objectContaining({ id: correction.id, originalMessageId: agentMessage.id }),
    ]);

    primitives.react({ messageId: humanMessage.id, actorId: "human-zhou", emoji: "👍" });
    primitives.react({ messageId: agentMessage.id, actorId: "human-lionel", emoji: "👎" });
    expect(primitives.calibrationSignalsFor("agent-data")).toEqual([
      expect.objectContaining({ emoji: "👎", agentId: "agent-data", sourceMessageId: agentMessage.id }),
    ]);
    expect(primitives.socialReactionsFor(humanMessage.id)).toEqual([
      expect.objectContaining({ emoji: "👍", actorId: "human-zhou" }),
    ]);
  });
});
