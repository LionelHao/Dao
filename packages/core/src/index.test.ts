import { describe, expect, it } from "vitest";
import * as importedDomain from "./index.js";

type DomainUnderTest = {
  isActor?: (value: unknown) => boolean;
  isAgentActor?: (value: unknown) => boolean;
  isEvent?: (value: unknown) => boolean;
  isHumanActor?: (value: unknown) => boolean;
  isMessage?: (value: unknown) => boolean;
  isRoom?: (value: unknown) => boolean;
};

const domain = importedDomain as unknown as DomainUnderTest;

describe("domain kernel guards", () => {
  it("distinguishes human reachability from agent readiness and guards all core records", () => {
    const human = {
      id: "human-lionel",
      kind: "human",
      displayName: "Lionel",
      reachability: "dnd",
    };
    const agent = {
      id: "agent-architecture",
      kind: "agent",
      displayName: "Architecture agent",
      readiness: "busy",
      toolPermissions: ["repository.read"],
    };

    expect(domain.isHumanActor).toBeTypeOf("function");
    expect(domain.isAgentActor).toBeTypeOf("function");
    expect(domain.isActor).toBeTypeOf("function");
    expect(domain.isEvent).toBeTypeOf("function");
    expect(domain.isMessage).toBeTypeOf("function");
    expect(domain.isRoom).toBeTypeOf("function");

    expect(domain.isHumanActor?.(human)).toBe(true);
    expect(domain.isAgentActor?.(agent)).toBe(true);
    expect(domain.isActor?.(human)).toBe(true);
    expect(domain.isActor?.(agent)).toBe(true);
    expect(domain.isAgentActor?.({ ...agent, readiness: "online" })).toBe(false);
    expect(domain.isHumanActor?.({ ...human, readiness: "ready" })).toBe(false);
    expect(
      domain.isEvent?.({
        id: "event-1",
        type: "room.created",
        actorId: human.id,
        actorKind: human.kind,
        roomId: "room-1",
        occurredAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      domain.isMessage?.({
        id: "message-1",
        roomId: "room-1",
        authorId: agent.id,
        authorKind: agent.kind,
        body: "I am ready.",
        sentAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      domain.isRoom?.({
        id: "room-1",
        name: "Native IM",
        memberIds: [human.id, agent.id],
        createdAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});
