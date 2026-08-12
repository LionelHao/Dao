import { describe, expect, it, vi } from "vitest";
import {
  createSubscriptionRegistry,
  type RegisteredConnection,
} from "./subscription-registry.js";

function connection(connectionId: string): RegisteredConnection {
  return {
    connectionId,
    principal: {
      accountId: `account-${connectionId}`,
      actorId: `principal-${connectionId}`,
    },
    sessionId: `session-${connectionId}`,
    sessionFamilyId: `family-${connectionId}`,
    credentialGeneration: 1,
    revoke: vi.fn(),
  };
}

describe("SubscriptionRegistry", () => {
  it("indexes room, principal, and session-family subscriptions independently", () => {
    const registry = createSubscriptionRegistry();
    const roomMember = connection("room-member");
    const removedPrincipal = connection("removed-principal");
    const revokedFamily = connection("revoked-family");

    registry.addRoom({ roomId: "room-1", connection: roomMember });
    registry.addPrincipal({ principalId: "human-removed", connection: removedPrincipal });
    registry.addSessionFamily({ familyId: "family-revoked", connection: revokedFamily });

    expect(registry.candidates({ targetKind: "room", targetId: "room-1" }))
      .toEqual([roomMember]);
    expect(registry.candidates({ targetKind: "principal", targetId: "human-removed" }))
      .toEqual([removedPrincipal]);
    expect(registry.candidates({ targetKind: "session-family", targetId: "family-revoked" }))
      .toEqual([revokedFamily]);
    expect(registry.candidates({ targetKind: "room", targetId: "missing" })).toEqual([]);
  });

  it("makes individual unsubscribe cleanup idempotent", () => {
    const registry = createSubscriptionRegistry();
    const member = connection("member");
    const unsubscribeFirst = registry.addRoom({ roomId: "room-1", connection: member });
    registry.addRoom({ roomId: "room-1", connection: member });

    unsubscribeFirst();
    unsubscribeFirst();

    expect(registry.candidates({ targetKind: "room", targetId: "room-1" }))
      .toEqual([member]);
  });

  it("revokes every index entry and invokes connection cleanup exactly once", () => {
    const registry = createSubscriptionRegistry();
    const member = connection("member");
    registry.addRoom({ roomId: "room-1", connection: member });
    registry.addRoom({ roomId: "room-2", connection: member });
    registry.addPrincipal({ principalId: member.principal.actorId, connection: member });
    registry.addSessionFamily({ familyId: member.sessionFamilyId, connection: member });

    registry.revokeConnection(member.connectionId);
    registry.revokeConnection(member.connectionId);

    expect(registry.candidates({ targetKind: "room", targetId: "room-1" })).toEqual([]);
    expect(registry.candidates({ targetKind: "room", targetId: "room-2" })).toEqual([]);
    expect(registry.candidates({ targetKind: "principal", targetId: member.principal.actorId }))
      .toEqual([]);
    expect(registry.candidates({
      targetKind: "session-family",
      targetId: member.sessionFamilyId,
    })).toEqual([]);
    expect(member.revoke).toHaveBeenCalledTimes(1);
  });
});
