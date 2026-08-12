import type {
  OutboxDelivery,
  OutboxDispatchCandidate,
} from "./persistence/contracts.js";

export interface RegisteredConnection extends OutboxDispatchCandidate {
  revoke(): void;
}

export interface RoomSubscription {
  readonly roomId: string;
  readonly connection: RegisteredConnection;
}

export interface PrincipalSubscription {
  readonly principalId: string;
  readonly connection: RegisteredConnection;
}

export interface SessionFamilySubscription {
  readonly familyId: string;
  readonly connection: RegisteredConnection;
}

export interface SubscriptionRegistry {
  addRoom(subscription: RoomSubscription): () => void;
  addPrincipal(subscription: PrincipalSubscription): () => void;
  addSessionFamily(subscription: SessionFamilySubscription): () => void;
  candidates(
    delivery: Pick<OutboxDelivery, "targetKind" | "targetId">,
  ): readonly RegisteredConnection[];
  revokeConnection(connectionId: string, expectedSessionFamilyId?: string): void;
}

type TargetKind = OutboxDelivery["targetKind"];

interface SubscriptionEntry {
  readonly kind: TargetKind;
  readonly targetId: string;
  readonly connectionId: string;
  active: boolean;
}

export function createSubscriptionRegistry(): SubscriptionRegistry {
  const connections = new Map<string, RegisteredConnection>();
  const entriesByConnection = new Map<string, Set<SubscriptionEntry>>();
  const indexes: Record<TargetKind, Map<string, Map<string, number>>> = {
    room: new Map(),
    principal: new Map(),
    "session-family": new Map(),
  };
  const revokedConnectionIds = new Set<string>();

  function add(
    kind: TargetKind,
    targetId: string,
    connection: RegisteredConnection,
  ): () => void {
    if (revokedConnectionIds.has(connection.connectionId)) {
      throw new TypeError("Cannot register a revoked connection");
    }
    const existingConnection = connections.get(connection.connectionId);
    if (existingConnection !== undefined && existingConnection !== connection) {
      throw new TypeError("Connection ID is already registered");
    }
    connections.set(connection.connectionId, connection);

    const counts = indexes[kind].get(targetId) ?? new Map<string, number>();
    counts.set(connection.connectionId, (counts.get(connection.connectionId) ?? 0) + 1);
    indexes[kind].set(targetId, counts);

    const entry: SubscriptionEntry = {
      kind,
      targetId,
      connectionId: connection.connectionId,
      active: true,
    };
    const connectionEntries = entriesByConnection.get(connection.connectionId) ?? new Set();
    connectionEntries.add(entry);
    entriesByConnection.set(connection.connectionId, connectionEntries);

    return () => {
      if (!entry.active) {
        return;
      }
      entry.active = false;
      connectionEntries.delete(entry);

      const currentCounts = indexes[kind].get(targetId);
      const currentCount = currentCounts?.get(connection.connectionId);
      if (currentCounts !== undefined && currentCount !== undefined) {
        if (currentCount === 1) {
          currentCounts.delete(connection.connectionId);
        } else {
          currentCounts.set(connection.connectionId, currentCount - 1);
        }
        if (currentCounts.size === 0) {
          indexes[kind].delete(targetId);
        }
      }

      if (connectionEntries.size === 0) {
        entriesByConnection.delete(connection.connectionId);
        connections.delete(connection.connectionId);
      }
    };
  }

  return {
    addRoom(subscription) {
      return add("room", subscription.roomId, subscription.connection);
    },

    addPrincipal(subscription) {
      return add("principal", subscription.principalId, subscription.connection);
    },

    addSessionFamily(subscription) {
      return add("session-family", subscription.familyId, subscription.connection);
    },

    candidates(delivery) {
      const connectionIds = indexes[delivery.targetKind].get(delivery.targetId);
      if (connectionIds === undefined) {
        return [];
      }
      return [...connectionIds.keys()]
        .map((connectionId) => connections.get(connectionId))
        .filter((connection): connection is RegisteredConnection => connection !== undefined);
    },

    revokeConnection(connectionId, expectedSessionFamilyId) {
      if (revokedConnectionIds.has(connectionId)) {
        return;
      }
      const connection = connections.get(connectionId);
      if (connection === undefined) {
        return;
      }
      if (
        expectedSessionFamilyId !== undefined &&
        connection.sessionFamilyId !== expectedSessionFamilyId
      ) {
        return;
      }
      revokedConnectionIds.add(connectionId);
      for (const entry of [...(entriesByConnection.get(connectionId) ?? [])]) {
        if (!entry.active) continue;
        entry.active = false;
        const counts = indexes[entry.kind].get(entry.targetId);
        const count = counts?.get(connectionId);
        if (counts !== undefined && count !== undefined) {
          if (count === 1) counts.delete(connectionId);
          else counts.set(connectionId, count - 1);
          if (counts.size === 0) indexes[entry.kind].delete(entry.targetId);
        }
      }
      entriesByConnection.delete(connectionId);
      connections.delete(connectionId);
      connection.revoke();
    },
  };
}
