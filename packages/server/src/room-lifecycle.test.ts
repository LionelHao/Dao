import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  AgentConfigurationRequest,
  ManagedRoom,
} from "@native-im/core";
import { describe, expect, it } from "vitest";
import {
  createJsonStateStore,
  createRoomLifecycleService,
  isRoomLifecycleState,
  RoomLifecycleError,
  StateStoreCorruptionError,
  type RoomLifecycleState,
  type StateStore,
} from "./index.js";
import { createAuthoritativeRoomLifecycleService } from "./room-lifecycle.js";
import type {
  AuthenticatedCommandContext,
  CommandStore,
  SyncQueryStore,
} from "./persistence/contracts.js";

const owner = {
  id: "human-owner",
  kind: "human",
  displayName: "Owner",
  reachability: "online",
} as const satisfies Actor;
const admin = {
  id: "human-admin",
  kind: "human",
  displayName: "Admin",
  reachability: "online",
} as const satisfies Actor;
const member = {
  id: "human-member",
  kind: "human",
  displayName: "Member",
  reachability: "offline",
} as const satisfies Actor;
const invitee = {
  id: "human-invitee",
  kind: "human",
  displayName: "Invitee",
  reachability: "dnd",
} as const satisfies Actor;
const searchAgent = {
  id: "agent-search",
  kind: "agent",
  displayName: "Search",
  readiness: "ready",
  toolPermissions: ["search", "summarize"],
} as const satisfies Actor;
const actors = [owner, admin, member, invitee, searchAgent] as const;

function sequenceFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function valuesFactory(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `unexpected-id-${index}`;
}

function createOptions(state: StateStore<RoomLifecycleState>) {
  return {
    actors,
    state,
    clock: () => Date.parse("2026-08-09T08:00:00.000Z"),
    idFactory: sequenceFactory("room-entity"),
    tokenFactory: sequenceFactory("invite-secret"),
  };
}

function humanMembership(
  actorId: string,
  role: "owner" | "admin" | "member",
  joinedAt = "2026-08-09T08:00:00.000Z",
) {
  return {
    kind: "human" as const,
    actorId,
    role,
    joinedAt,
  };
}

function ownerFixture(): RoomLifecycleState {
  return {
    version: 1,
    actors,
    rooms: [
      {
        id: "fixture-room",
        name: "Fixture",
        status: "active",
        members: [humanMembership(owner.id, "owner")],
        createdAt: "2026-08-09T08:00:00.000Z",
      },
    ],
    invitations: [],
    audit: [
      {
        id: "audit-room-created",
        type: "room.created",
        roomId: "fixture-room",
        actorId: owner.id,
        result: "created",
        timestamp: "2026-08-09T08:00:00.000Z",
      },
    ],
  };
}

function adminFixture(): RoomLifecycleState {
  const state = ownerFixture();
  const adminInvitationId = "invitation-admin";
  const memberInvitationId = "invitation-member";
  return {
    ...state,
    rooms: [
      {
        ...state.rooms[0]!,
        members: [
          humanMembership(owner.id, "owner"),
          humanMembership(
            admin.id,
            "admin",
            "2026-08-09T08:02:00.000Z",
          ),
          humanMembership(
            member.id,
            "member",
            "2026-08-09T08:05:00.000Z",
          ),
        ],
      },
    ],
    invitations: [
      {
        id: adminInvitationId,
        roomId: "fixture-room",
        inviterActorId: owner.id,
        inviteeActorId: admin.id,
        tokenHash: createHash("sha256")
          .update("admin-fixture-token")
          .digest("base64url"),
        status: "accepted",
        createdAt: "2026-08-09T08:01:00.000Z",
        decisionActorId: admin.id,
        decidedAt: "2026-08-09T08:02:00.000Z",
      },
      {
        id: memberInvitationId,
        roomId: "fixture-room",
        inviterActorId: owner.id,
        inviteeActorId: member.id,
        tokenHash: createHash("sha256")
          .update("member-fixture-token")
          .digest("base64url"),
        status: "accepted",
        createdAt: "2026-08-09T08:04:00.000Z",
        decisionActorId: member.id,
        decidedAt: "2026-08-09T08:05:00.000Z",
      },
    ],
    audit: [
      ...state.audit,
      {
        id: "audit-admin-invited",
        type: "room.human.invited",
        roomId: "fixture-room",
        actorId: owner.id,
        targetActorId: admin.id,
        invitationId: adminInvitationId,
        result: "pending",
        timestamp: "2026-08-09T08:01:00.000Z",
      },
      {
        id: "audit-admin-accepted",
        type: "room.invitation.accepted",
        roomId: "fixture-room",
        actorId: admin.id,
        targetActorId: admin.id,
        inviterActorId: owner.id,
        invitationId: adminInvitationId,
        result: "accepted",
        timestamp: "2026-08-09T08:02:00.000Z",
      },
      {
        id: "audit-admin-role",
        type: "room.member.role.changed",
        roomId: "fixture-room",
        actorId: owner.id,
        targetActorId: admin.id,
        role: "admin",
        result: "role-changed",
        timestamp: "2026-08-09T08:03:00.000Z",
      },
      {
        id: "audit-member-invited",
        type: "room.human.invited",
        roomId: "fixture-room",
        actorId: owner.id,
        targetActorId: member.id,
        invitationId: memberInvitationId,
        result: "pending",
        timestamp: "2026-08-09T08:04:00.000Z",
      },
      {
        id: "audit-member-accepted",
        type: "room.invitation.accepted",
        roomId: "fixture-room",
        actorId: member.id,
        targetActorId: member.id,
        inviterActorId: owner.id,
        invitationId: memberInvitationId,
        result: "accepted",
        timestamp: "2026-08-09T08:05:00.000Z",
      },
    ],
  };
}

describe("authoritative RoomLifecycle facade", () => {
  it("routes every mutation and query through authority ports", async () => {
    const commandsSeen: string[] = [];
    let archivedRoomReadPending = false;
    const state = ownerFixture();
    const managedRoom = state.rooms[0]!;
    const context: AuthenticatedCommandContext = {
      kind: "human",
      sessionId: "session-authority",
      sessionFamilyId: "family-authority",
      principal: { accountId: "account-owner", actorId: owner.id },
      requestId: "lifecycle-request",
      idempotencyKey: "lifecycle-key",
    };
    const commands: CommandStore = {
      async executeHuman(received, command) {
        expect(received).toBe(context);
        commandsSeen.push(command.type);
        if (command.type === "room.archive") {
          expect(command.payload).toEqual({ expectedGovernanceRevision: 1 });
          archivedRoomReadPending = true;
        }
        if (command.type === "human.invitation.issue") {
          return {
            aggregateId: "invitation-authority",
            eventIds: ["event-invitation"],
            acceptedAt: "2026-08-10T15:00:00.000Z",
            result: {
              invitation: {
                invitationId: "invitation-authority",
                roomId: managedRoom.id,
                inviterActorId: owner.id,
                inviteeActorId: invitee.id,
                token: "authority-token",
                createdAt: "2026-08-10T15:00:00.000Z",
              },
            },
          };
        }
        if (command.type === "human.invitation.decide") {
          return {
            aggregateId: "invitation-authority",
            eventIds: ["event-decision"],
            acceptedAt: "2026-08-10T15:01:00.000Z",
            result: {
              invitation: {
                id: "invitation-authority",
                roomId: managedRoom.id,
                inviterActorId: owner.id,
                inviteeActorId: invitee.id,
                status: "accepted",
                createdAt: "2026-08-10T15:00:00.000Z",
                decisionActorId: invitee.id,
                decidedAt: "2026-08-10T15:01:00.000Z",
              },
            },
          };
        }
        return {
          aggregateId: managedRoom.id,
          eventIds: [`event-${command.type}`],
          acceptedAt: "2026-08-10T15:00:00.000Z",
          result: { room: managedRoom },
        };
      },
      executeAgent() {
        throw new Error("unexpected Agent governance");
      },
    };
    const queries: SyncQueryStore = {
      async readActor(actorId) {
        expect(actorId).toBe(owner.id);
        return owner;
      },
      async readRoom(roomId) {
        expect(roomId).toBe(managedRoom.id);
        if (archivedRoomReadPending) {
          archivedRoomReadPending = false;
          return { ...managedRoom, status: "archived" };
        }
        return managedRoom;
      },
      async readRoomGovernance(received, roomId) {
        expect(received).toBe(context);
        expect(roomId).toBe(managedRoom.id);
        return {
          roomId,
          projectId: roomId,
          lifecycle: "active",
          governanceRevision: 1,
          ownerActorId: owner.id,
          archiveGeneration: 0,
        };
      },
      async canAccessRoom(received, roomId) {
        expect(received).toEqual({
          sessionId: context.sessionId,
          sessionFamilyId: context.sessionFamilyId,
          principal: context.principal,
        });
        expect(roomId).toBe(managedRoom.id);
        return true;
      },
      async readRoomAudit(received, roomId) {
        expect(received.principal).toEqual(context.principal);
        expect(roomId).toBe(managedRoom.id);
        return state.audit;
      },
      syncRoom() {
        throw new Error("unexpected sync");
      },
      readHistory() {
        throw new Error("unexpected history");
      },
      async listPendingOutbox() {
        return [];
      },
      async markOutboxDispatched() {},
    };
    const lifecycle = createAuthoritativeRoomLifecycleService({
      commandStore: commands,
      queryStore: queries,
    });

    await lifecycle.createRoom(context, { name: "Governance" });
    await lifecycle.renameRoom(context, managedRoom.id, "Renamed");
    await lifecycle.archiveRoom(context, managedRoom.id);
    await lifecycle.inviteHuman(context, {
      kind: "human-invitation",
      roomId: managedRoom.id,
      inviteeActorId: invitee.id,
    });
    await lifecycle.respondToHumanInvitation(context, "authority-token", "accept");
    await lifecycle.configureAgent(context, {
      kind: "agent-configuration",
      roomId: managedRoom.id,
      agentId: searchAgent.id,
      participation: "active",
      toolPermissions: ["search"],
    });
    await lifecycle.setHumanRole(context, managedRoom.id, member.id, "admin");
    await lifecycle.removeMember(context, managedRoom.id, member.id);

    expect(commandsSeen).toEqual([
      "room.create",
      "room.rename",
      "room.archive",
      "human.invitation.issue",
      "human.invitation.decide",
      "agent.configure",
      "human.role.change",
      "member.remove",
    ]);
    await expect(lifecycle.getActor(owner.id)).resolves.toEqual(owner);
    await expect(lifecycle.getRoom(managedRoom.id)).resolves.toEqual(managedRoom);
    await expect(lifecycle.canAccess(context, managedRoom.id)).resolves.toBe(true);
    await expect(lifecycle.audit(context, managedRoom.id)).resolves.toEqual(state.audit);
  });
});

function invitationAuthorityFixture(
  status: "pending" | "accepted" | "rejected",
): Record<string, unknown> {
  const invitationId = "invitation-linked";
  const createdAt = "2026-08-09T08:01:00.000Z";
  const decidedAt = "2026-08-09T08:02:00.000Z";
  const invitation = {
    id: invitationId,
    roomId: "fixture-room",
    inviterActorId: owner.id,
    inviteeActorId: invitee.id,
    tokenHash: createHash("sha256")
      .update("linked-invitation-token")
      .digest("base64url"),
    status,
    createdAt,
    ...(status === "pending"
      ? {}
      : { decisionActorId: invitee.id, decidedAt }),
  };
  const issuanceAudit = {
    id: "audit-invitation-issued",
    type: "room.human.invited",
    roomId: "fixture-room",
    actorId: owner.id,
    targetActorId: invitee.id,
    invitationId,
    result: "pending",
    timestamp: createdAt,
  };
  const decisionAudit = {
    id: "audit-invitation-decided",
    type:
      status === "accepted"
        ? "room.invitation.accepted"
        : "room.invitation.rejected",
    roomId: "fixture-room",
    actorId: invitee.id,
    targetActorId: invitee.id,
    inviterActorId: owner.id,
    invitationId,
    result: status,
    timestamp: decidedAt,
  };

  return {
    ...ownerFixture(),
    rooms: [
      {
        ...ownerFixture().rooms[0]!,
        members:
          status === "accepted"
            ? [
                humanMembership(owner.id, "owner"),
                humanMembership(invitee.id, "member", decidedAt),
              ]
            : [humanMembership(owner.id, "owner")],
      },
    ],
    invitations: [invitation],
    audit:
      status === "pending"
        ? [...ownerFixture().audit, issuanceAudit]
        : [...ownerFixture().audit, issuanceAudit, decisionAudit],
  };
}

function mutableAuditByType(
  state: Record<string, unknown>,
  type: string,
): Record<string, unknown> {
  const record = (state.audit as Record<string, unknown>[]).find(
    (candidate) => candidate.type === type,
  );
  if (record === undefined) {
    throw new Error(`missing ${type} fixture audit`);
  }
  return record;
}

function archivedAuthorityFixture(): Record<string, unknown> {
  const state = structuredClone(ownerFixture()) as unknown as Record<
    string,
    unknown
  >;
  const fixtureRooms = state.rooms as Record<string, unknown>[];
  fixtureRooms[0] = { ...fixtureRooms[0], status: "archived" };
  (state.audit as unknown[]).push({
    id: "audit-room-archived",
    type: "room.archived",
    roomId: "fixture-room",
    actorId: owner.id,
    result: "archived",
    timestamp: "2026-08-09T08:01:00.000Z",
  });
  return state;
}

function acceptedThenRemovedFixture(): Record<string, unknown> {
  const state = invitationAuthorityFixture("accepted");
  const fixtureRooms = state.rooms as Record<string, unknown>[];
  const memberships = fixtureRooms[0]?.members as Record<string, unknown>[];
  fixtureRooms[0] = {
    ...fixtureRooms[0],
    members: memberships.filter(
      (membership) => membership.actorId !== invitee.id,
    ),
  };
  (state.audit as unknown[]).push({
    id: "audit-invitee-removed",
    type: "room.member.removed",
    roomId: "fixture-room",
    actorId: owner.id,
    targetActorId: invitee.id,
    result: "removed",
    timestamp: "2026-08-09T08:03:00.000Z",
  });
  return state;
}

function agentAuthorityFixture(): Record<string, unknown> {
  const state = structuredClone(ownerFixture()) as unknown as Record<
    string,
    unknown
  >;
  const fixtureRooms = state.rooms as Record<string, unknown>[];
  const memberships = fixtureRooms[0]?.members as unknown[];
  memberships.push({
    kind: "agent",
    actorId: searchAgent.id,
    participation: "active",
    toolPermissions: ["search"],
    configuredAt: "2026-08-09T08:01:00.000Z",
  });
  (state.audit as unknown[]).push({
    id: "audit-agent-configured",
    type: "room.agent.configured",
    roomId: "fixture-room",
    actorId: owner.id,
    targetActorId: searchAgent.id,
    participation: "active",
    toolPermissions: ["search"],
    result: "configured",
    timestamp: "2026-08-09T08:01:00.000Z",
  });
  return state;
}

class MemoryRoomStore implements StateStore<RoomLifecycleState> {
  current: RoomLifecycleState | undefined;
  private nextSaveError: unknown;

  constructor(initial?: RoomLifecycleState) {
    this.current = initial;
  }

  async load(): Promise<RoomLifecycleState | undefined> {
    return this.current;
  }

  async save(value: RoomLifecycleState): Promise<void> {
    if (this.nextSaveError !== undefined) {
      const error = this.nextSaveError;
      this.nextSaveError = undefined;
      throw error;
    }
    this.current = value;
  }

  failNextSave(error: unknown): void {
    this.nextSaveError = error;
  }
}

async function addHumanMember(
  rooms: Awaited<ReturnType<typeof createRoomLifecycleService>>,
  roomId: string,
  actorId: string,
): Promise<void> {
  const issued = await rooms.inviteHuman(owner.id, {
    kind: "human-invitation",
    roomId,
    inviteeActorId: actorId,
  });
  await rooms.respondToHumanInvitation(actorId, issued.token, "accept");
}

describe("room lifecycle authority state guard", () => {
  it("accepts a closed, internally consistent fixture", () => {
    expect(isRoomLifecycleState(adminFixture())).toBe(true);
  });

  it.each([
    {
      description: "room without creation evidence",
      mutate(state: Record<string, unknown>) {
        state.audit = (state.audit as Record<string, unknown>[]).filter(
          (record) => record.type !== "room.created",
        );
      },
    },
    {
      description: "room with duplicate creation evidence",
      mutate(state: Record<string, unknown>) {
        (state.audit as unknown[]).push({
          ...mutableAuditByType(state, "room.created"),
          id: "audit-room-created-again",
        });
      },
    },
    {
      description: "room created by someone other than its owner",
      mutate(state: Record<string, unknown>) {
        mutableAuditByType(state, "room.created").actorId = admin.id;
      },
    },
    {
      description: "room creation timestamp different from owner join time",
      mutate(state: Record<string, unknown>) {
        mutableAuditByType(state, "room.created").timestamp =
          "2026-08-09T07:59:00.000Z";
      },
    },
  ])("rejects a $description", ({ mutate }) => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    mutate(candidate);
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("accepts exactly one archive transition for an archived room", () => {
    expect(isRoomLifecycleState(archivedAuthorityFixture())).toBe(true);
  });

  it("rejects an archive audit while the room remains active", () => {
    const candidate = archivedAuthorityFixture();
    const fixtureRooms = candidate.rooms as Record<string, unknown>[];
    fixtureRooms[0] = { ...fixtureRooms[0], status: "active" };
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects an archived room without archive evidence", () => {
    const candidate = archivedAuthorityFixture();
    candidate.audit = (candidate.audit as Record<string, unknown>[]).filter(
      (record) => record.type !== "room.archived",
    );
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects duplicate archive evidence", () => {
    const candidate = archivedAuthorityFixture();
    (candidate.audit as unknown[]).push({
      ...mutableAuditByType(candidate, "room.archived"),
      id: "audit-room-archived-again",
      timestamp: "2026-08-09T08:02:00.000Z",
    });
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects multiple owner memberships without an ownership model", () => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    const fixtureRooms = candidate.rooms as Record<string, unknown>[];
    const memberships = fixtureRooms[0]?.members as Record<string, unknown>[];
    memberships[1] = { ...memberships[1], role: "owner" };
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects an accepted invitee absent without subsequent removal", () => {
    const candidate = invitationAuthorityFixture("accepted");
    const fixtureRooms = candidate.rooms as Record<string, unknown>[];
    const memberships = fixtureRooms[0]?.members as Record<string, unknown>[];
    fixtureRooms[0] = {
      ...fixtureRooms[0],
      members: memberships.filter(
        (membership) => membership.actorId !== invitee.id,
      ),
    };
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("accepts an accepted invitee removed after acceptance", () => {
    expect(isRoomLifecycleState(acceptedThenRemovedFixture())).toBe(true);
  });

  it("rejects removal evidence ordered before invitation acceptance", () => {
    const candidate = acceptedThenRemovedFixture();
    mutableAuditByType(candidate, "room.member.removed").timestamp =
      "2026-08-09T08:01:30.000Z";
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects an arbitrary admin membership without a role transition", () => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    candidate.audit = (candidate.audit as Record<string, unknown>[]).filter(
      (record) => record.type !== "room.member.role.changed",
    );
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects a role transition sequence whose final role mismatches membership", () => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    mutableAuditByType(candidate, "room.member.role.changed").role = "member";
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects a redundant role-change audit that the service cannot emit", () => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    (candidate.audit as unknown[]).push({
      id: "audit-admin-role-redundant",
      type: "room.member.role.changed",
      roomId: "fixture-room",
      actorId: owner.id,
      targetActorId: admin.id,
      role: "admin",
      result: "role-changed",
      timestamp: "2026-08-09T08:06:00.000Z",
    });
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("accepts a replayable admin demotion back to member", () => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    const fixtureRooms = candidate.rooms as Record<string, unknown>[];
    const memberships = fixtureRooms[0]?.members as Record<string, unknown>[];
    memberships[1] = { ...memberships[1], role: "member" };
    (candidate.audit as unknown[]).push({
      id: "audit-admin-demoted",
      type: "room.member.role.changed",
      roomId: "fixture-room",
      actorId: owner.id,
      targetActorId: admin.id,
      role: "member",
      result: "role-changed",
      timestamp: "2026-08-09T08:06:00.000Z",
    });
    expect(isRoomLifecycleState(candidate)).toBe(true);
  });

  it("accepts agent configuration and subsequent removal as reachable", () => {
    const configured = agentAuthorityFixture();
    expect(isRoomLifecycleState(configured)).toBe(true);

    const removed = agentAuthorityFixture();
    const fixtureRooms = removed.rooms as Record<string, unknown>[];
    const memberships = fixtureRooms[0]?.members as Record<string, unknown>[];
    fixtureRooms[0] = {
      ...fixtureRooms[0],
      members: memberships.filter(
        (membership) => membership.actorId !== searchAgent.id,
      ),
    };
    (removed.audit as unknown[]).push({
      id: "audit-agent-removed",
      type: "room.member.removed",
      roomId: "fixture-room",
      actorId: owner.id,
      targetActorId: searchAgent.id,
      result: "removed",
      timestamp: "2026-08-09T08:02:00.000Z",
    });
    expect(isRoomLifecycleState(removed)).toBe(true);
  });

  it("rejects zero-grant agent authority snapshots", () => {
    const emptyMembership = agentAuthorityFixture();
    const membershipRooms = emptyMembership.rooms as Record<string, unknown>[];
    const memberships = membershipRooms[0]?.members as Record<string, unknown>[];
    const agentMembership = memberships.find(
      (membership) => membership.actorId === searchAgent.id,
    );
    if (agentMembership === undefined) {
      throw new Error("agent authority fixture must contain an agent membership");
    }
    agentMembership.toolPermissions = [];
    expect(isRoomLifecycleState(emptyMembership)).toBe(false);

    const emptyAudit = agentAuthorityFixture();
    const audits = emptyAudit.audit as Record<string, unknown>[];
    const configuredAudit = audits.find(
      (record) => record.type === "room.agent.configured",
    );
    if (configuredAudit === undefined) {
      throw new Error("agent authority fixture must contain a configuration audit");
    }
    configuredAudit.toolPermissions = [];
    expect(isRoomLifecycleState(emptyAudit)).toBe(false);
  });

  it("rejects an agent membership without configuration evidence", () => {
    const candidate = agentAuthorityFixture();
    candidate.audit = (candidate.audit as Record<string, unknown>[]).filter(
      (record) => record.type !== "room.agent.configured",
    );
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects an agent membership differing from its latest configuration", () => {
    const candidate = agentAuthorityFixture();
    const fixtureRooms = candidate.rooms as Record<string, unknown>[];
    const memberships = fixtureRooms[0]?.members as Record<string, unknown>[];
    const agentMembership = memberships.find(
      (membership) => membership.actorId === searchAgent.id,
    );
    if (agentMembership === undefined) {
      throw new Error("agent fixture membership is missing");
    }
    agentMembership.participation = "silent";
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it.each(["pending", "accepted", "rejected"] as const)(
    "accepts a %s invitation with exactly linked issuance and decision evidence",
    (status) => {
      expect(isRoomLifecycleState(invitationAuthorityFixture(status))).toBe(true);
    },
  );

  it.each([
    {
      description: "terminal invitation without a decision audit",
      mutate(state: Record<string, unknown>) {
        (state.audit as unknown[]).pop();
      },
    },
    {
      description: "accepted invitation with a rejected decision audit",
      mutate(state: Record<string, unknown>) {
        Object.assign(
          mutableAuditByType(state, "room.invitation.accepted"),
          {
          type: "room.invitation.rejected",
          result: "rejected",
          },
        );
      },
    },
    {
      description: "orphan decision audit",
      mutate(state: Record<string, unknown>) {
        mutableAuditByType(state, "room.invitation.accepted").invitationId =
          "invitation-missing";
      },
    },
    {
      description: "duplicate decision audit",
      mutate(state: Record<string, unknown>) {
        const audit = state.audit as Record<string, unknown>[];
        audit.push({
          ...mutableAuditByType(state, "room.invitation.accepted"),
          id: "audit-invitation-decided-again",
        });
      },
    },
    {
      description: "decision audit by the wrong actor",
      mutate(state: Record<string, unknown>) {
        mutableAuditByType(state, "room.invitation.accepted").actorId = admin.id;
      },
    },
    {
      description: "decision audit for the wrong existing room",
      mutate(state: Record<string, unknown>) {
        const fixtureRooms = state.rooms as Record<string, unknown>[];
        fixtureRooms.push({ ...fixtureRooms[0], id: "fixture-room-other" });
        mutableAuditByType(state, "room.invitation.accepted").roomId =
          "fixture-room-other";
      },
    },
  ])("rejects $description", ({ mutate }) => {
    const candidate = structuredClone(invitationAuthorityFixture("accepted"));
    mutate(candidate);
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects a pending invitation with decision evidence", () => {
    const candidate = invitationAuthorityFixture("pending");
    const terminal = invitationAuthorityFixture("accepted");
    (candidate.audit as unknown[]).push(
      structuredClone(
        mutableAuditByType(terminal, "room.invitation.accepted"),
      ),
    );
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects a terminal decision timestamp before invitation issuance", () => {
    const candidate = invitationAuthorityFixture("accepted");
    const invitations = candidate.invitations as Record<string, unknown>[];
    invitations[0] = {
      ...invitations[0],
      decidedAt: "2026-08-09T07:59:00.000Z",
    };
    mutableAuditByType(candidate, "room.invitation.accepted").timestamp =
      "2026-08-09T07:59:00.000Z";

    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it.each([
    {
      description: "missing issuance audit",
      mutate(state: Record<string, unknown>) {
        state.audit = (state.audit as Record<string, unknown>[]).filter(
          (record) => record.type !== "room.human.invited",
        );
      },
    },
    {
      description: "orphan issuance audit",
      mutate(state: Record<string, unknown>) {
        mutableAuditByType(state, "room.human.invited").invitationId =
          "invitation-missing";
      },
    },
    {
      description: "issuance audit with a mismatched inviter",
      mutate(state: Record<string, unknown>) {
        mutableAuditByType(state, "room.human.invited").actorId = admin.id;
      },
    },
  ])("rejects $description", ({ mutate }) => {
    const candidate = structuredClone(invitationAuthorityFixture("pending"));
    mutate(candidate);
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it.each([
    {
      description: "accepted versus rejected mismatch",
      mutate(state: Record<string, unknown>) {
        Object.assign(
          mutableAuditByType(state, "room.invitation.accepted"),
          {
          type: "room.invitation.rejected",
          result: "rejected",
          },
        );
      },
    },
    {
      description: "terminal invitation missing its decision audit",
      mutate(state: Record<string, unknown>) {
        (state.audit as unknown[]).pop();
      },
    },
    {
      description: "orphan decision audit",
      mutate(state: Record<string, unknown>) {
        mutableAuditByType(state, "room.invitation.accepted").invitationId =
          "invitation-missing";
      },
    },
  ])("loads $description as corruption", async ({ mutate }) => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-room-link-guard-"));
    const filePath = join(directory, "rooms.json");
    try {
      const candidate = structuredClone(invitationAuthorityFixture("accepted"));
      mutate(candidate);
      await writeFile(filePath, JSON.stringify(candidate), "utf8");
      await expect(
        createJsonStateStore(filePath, isRoomLifecycleState).load(),
      ).rejects.toBeInstanceOf(StateStoreCorruptionError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      description: "secret-bearing actor field",
      mutate(state: Record<string, unknown>) {
        const actorList = state.actors as Record<string, unknown>[];
        actorList[0] = { ...actorList[0], secret: "credential" };
      },
    },
    {
      description: "duplicate actor ID",
      mutate(state: Record<string, unknown>) {
        const actorList = state.actors as Record<string, unknown>[];
        actorList.push({ ...actorList[0] });
      },
    },
    {
      description: "duplicate room ID",
      mutate(state: Record<string, unknown>) {
        const rooms = state.rooms as Record<string, unknown>[];
        rooms.push({ ...rooms[0] });
      },
    },
    {
      description: "duplicate room membership",
      mutate(state: Record<string, unknown>) {
        const rooms = state.rooms as Record<string, unknown>[];
        const memberships = rooms[0]?.members as Record<string, unknown>[];
        memberships.push({ ...memberships[0] });
      },
    },
    {
      description: "unknown membership actor",
      mutate(state: Record<string, unknown>) {
        const rooms = state.rooms as Record<string, unknown>[];
        const memberships = rooms[0]?.members as Record<string, unknown>[];
        memberships[1] = { ...memberships[1], actorId: "human-missing" };
      },
    },
    {
      description: "malformed audit reference",
      mutate(state: Record<string, unknown>) {
        state.audit = [
          {
            id: "audit-bad-room",
            type: "room.created",
            roomId: "room-missing",
            actorId: owner.id,
            result: "created",
            timestamp: "2026-08-09T08:00:00.000Z",
          },
        ];
      },
    },
  ])("rejects $description", ({ mutate }) => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    mutate(candidate);
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it.each(["token", "rawToken", "secret"])(
    "rejects an invitation carrying a raw %s field",
    (field) => {
      const candidate = structuredClone(adminFixture()) as unknown as Record<
        string,
        unknown
      >;
      candidate.invitations = [
        {
          id: "invitation-1",
          roomId: "fixture-room",
          inviterActorId: owner.id,
          inviteeActorId: invitee.id,
          tokenHash: createHash("sha256").update("token-1").digest("base64url"),
          status: "pending",
          createdAt: "2026-08-09T08:00:00.000Z",
          [field]: "must-not-persist",
        },
      ];

      expect(isRoomLifecycleState(candidate)).toBe(false);
    },
  );

  it("rejects duplicate invitation token hashes and entity IDs", () => {
    const invitation = {
      id: "invitation-1",
      roomId: "fixture-room",
      inviterActorId: owner.id,
      inviteeActorId: invitee.id,
      tokenHash: createHash("sha256").update("token-1").digest("base64url"),
      status: "pending" as const,
      createdAt: "2026-08-09T08:00:00.000Z",
    };
    const candidate = {
      ...adminFixture(),
      invitations: [
        invitation,
        { ...invitation, id: "invitation-2", inviteeActorId: member.id },
      ],
    };
    expect(isRoomLifecycleState(candidate)).toBe(false);

    expect(
      isRoomLifecycleState({
        ...adminFixture(),
        invitations: [{ ...invitation, id: "fixture-room" }],
      }),
    ).toBe(false);
  });

  it.each([
    {
      description: "room ID colliding with an actor ID",
      candidate() {
        const state = structuredClone(adminFixture()) as unknown as Record<
          string,
          unknown
        >;
        const rooms = state.rooms as Record<string, unknown>[];
        rooms[0] = { ...rooms[0], id: owner.id };
        return state;
      },
    },
    {
      description: "invitation ID colliding with an actor ID",
      candidate() {
        const state = invitationAuthorityFixture("pending");
        const invitations = state.invitations as Record<string, unknown>[];
        invitations[0] = { ...invitations[0], id: admin.id };
        mutableAuditByType(state, "room.human.invited").invitationId = admin.id;
        return state;
      },
    },
    {
      description: "audit ID colliding with an actor ID",
      candidate() {
        const state = invitationAuthorityFixture("pending");
        const audit = state.audit as Record<string, unknown>[];
        audit[0] = { ...audit[0], id: searchAgent.id };
        return state;
      },
    },
    {
      description: "invitation ID colliding with its room ID",
      candidate() {
        const state = invitationAuthorityFixture("pending");
        const invitations = state.invitations as Record<string, unknown>[];
        invitations[0] = { ...invitations[0], id: "fixture-room" };
        mutableAuditByType(state, "room.human.invited").invitationId =
          "fixture-room";
        return state;
      },
    },
    {
      description: "audit ID colliding with its invitation ID",
      candidate() {
        const state = invitationAuthorityFixture("pending");
        const invitations = state.invitations as Record<string, unknown>[];
        const invitationId = invitations[0]?.id;
        const audit = state.audit as Record<string, unknown>[];
        audit[0] = { ...audit[0], id: invitationId };
        return state;
      },
    },
  ])("rejects $description in the global entity namespace", ({ candidate }) => {
    expect(isRoomLifecycleState(candidate())).toBe(false);
  });

  it("rejects a pending invitation for an existing room member", () => {
    const candidate = {
      ...adminFixture(),
      invitations: [
        {
          id: "invitation-existing-member",
          roomId: "fixture-room",
          inviterActorId: owner.id,
          inviteeActorId: member.id,
          tokenHash: createHash("sha256")
            .update("existing-member-token")
            .digest("base64url"),
          status: "pending",
          createdAt: "2026-08-09T08:00:00.000Z",
        },
      ],
    };

    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it.each([
    {
      description: "agent-authored room creation",
      audit: {
        id: "audit-agent-created",
        type: "room.created",
        roomId: "fixture-room",
        actorId: searchAgent.id,
        result: "created",
        timestamp: "2026-08-09T08:00:00.000Z",
      },
    },
    {
      description: "agent configuration targeting a human",
      audit: {
        id: "audit-agent-target-human",
        type: "room.agent.configured",
        roomId: "fixture-room",
        actorId: owner.id,
        targetActorId: member.id,
        result: "configured",
        timestamp: "2026-08-09T08:00:00.000Z",
      },
    },
    {
      description: "invitation decision by someone other than its target",
      audit: {
        id: "audit-wrong-decision-actor",
        type: "room.invitation.accepted",
        roomId: "fixture-room",
        actorId: admin.id,
        targetActorId: invitee.id,
        inviterActorId: owner.id,
        result: "accepted",
        timestamp: "2026-08-09T08:00:00.000Z",
      },
    },
  ])("rejects $description in audit evidence", ({ audit }) => {
    expect(isRoomLifecycleState({ ...adminFixture(), audit: [audit] })).toBe(false);
  });

  it.each([
    {
      description: "agent participation",
      membership: {
        kind: "agent",
        actorId: searchAgent.id,
        toolPermissions: ["search"],
        configuredAt: "2026-08-09T08:00:00.000Z",
      },
    },
    {
      description: "agent tool permissions",
      membership: {
        kind: "agent",
        actorId: searchAgent.id,
        participation: "active",
        configuredAt: "2026-08-09T08:00:00.000Z",
      },
    },
  ])("rejects a runtime membership missing $description", ({ membership }) => {
    const candidate = structuredClone(adminFixture()) as unknown as Record<
      string,
      unknown
    >;
    const fixtureRooms = candidate.rooms as Record<string, unknown>[];
    (fixtureRooms[0]?.members as unknown[]).push(membership);
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("surfaces invalid persisted authority as corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-room-guard-"));
    const filePath = join(directory, "rooms.json");
    try {
      await writeFile(
        filePath,
        JSON.stringify({ ...adminFixture(), accessToken: "secret" }),
        "utf8",
      );
      const store = createJsonStateStore(filePath, isRoomLifecycleState);
      await expect(store.load()).rejects.toBeInstanceOf(StateStoreCorruptionError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("room lifecycle service", () => {
  it("authorizes a routed invite and agent configuration before validating their payload", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Payload authz" });
    await addHumanMember(rooms, room.id, member.id);

    await expect(
      rooms.inviteHuman(
        member.id,
        {
          kind: "human-invitation",
          roomId: room.id,
          inviteeActorId: 42,
        } as never,
      ),
    ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    await expect(
      rooms.configureAgent(
        member.id,
        {
          kind: "agent-configuration",
          roomId: room.id,
          agentId: 42,
          participation: "invalid",
          toolPermissions: "search",
        } as never,
      ),
    ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
  });

  it.each(["", "human-missing"])(
    "authenticates caller %j before routed payload validation",
    async (actorId) => {
      const rooms = await createRoomLifecycleService(
        createOptions(new MemoryRoomStore()),
      );
      const room = await rooms.createRoom(owner.id, { name: "Payload authn" });

      await expect(
        rooms.inviteHuman(
          actorId,
          { roomId: room.id, inviteeActorId: 42 } as never,
        ),
      ).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
      await expect(
        rooms.configureAgent(
          actorId,
          { roomId: room.id, agentId: 42 } as never,
        ),
      ).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    },
  );

  it.each(["", "human-missing"])(
    "authenticates invitation respondent %j before validating its decision",
    async (actorId) => {
      const rooms = await createRoomLifecycleService(
        createOptions(new MemoryRoomStore()),
      );

      await expect(
        rooms.respondToHumanInvitation(
          actorId,
          "unknown-token",
          "invalid" as never,
        ),
      ).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    },
  );

  it("authorizes the targeted invitation actor before validating the decision", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Decision authz" });
    const invitation = await rooms.inviteHuman(owner.id, {
      kind: "human-invitation",
      roomId: room.id,
      inviteeActorId: invitee.id,
    });

    await expect(
      rooms.respondToHumanInvitation(
        member.id,
        invitation.token,
        "invalid" as never,
      ),
    ).rejects.toMatchObject({ status: 403, code: "invitation_forbidden" });
    await expect(
      rooms.respondToHumanInvitation(
        "human-missing",
        invitation.token,
        "invalid" as never,
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    await expect(
      rooms.respondToHumanInvitation(
        invitee.id,
        invitation.token,
        "invalid" as never,
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "invitation_decision_invalid",
    });
  });

  it("returns typed payload errors for an authenticated owner without raw TypeErrors", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );

    await expect(rooms.inviteHuman(owner.id, null as never)).rejects.toMatchObject({
      status: 400,
      code: "human_invitation_invalid",
    });
    await expect(
      rooms.configureAgent(owner.id, null as never),
    ).rejects.toMatchObject({
      status: 400,
      code: "agent_configuration_invalid",
    });
  });

  it("promotes an invited member into an admin who can perform every manager action", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Reachable admin" });
    await addHumanMember(rooms, room.id, member.id);
    await addHumanMember(rooms, room.id, invitee.id);

    await expect(
      rooms.setHumanRole(owner.id, room.id, member.id, "admin"),
    ).resolves.toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ actorId: member.id, role: "admin" }),
      ]),
    });
    expect(rooms.audit(room.id)).toContainEqual(
      expect.objectContaining({
        type: "room.member.role.changed",
        actorId: owner.id,
        targetActorId: member.id,
        role: "admin",
        result: "role-changed",
      }),
    );

    await expect(
      rooms.renameRoom(member.id, room.id, "Admin renamed"),
    ).resolves.toMatchObject({ name: "Admin renamed" });
    await expect(
      rooms.inviteHuman(member.id, {
        kind: "human-invitation",
        roomId: room.id,
        inviteeActorId: admin.id,
      }),
    ).resolves.toMatchObject({ inviterActorId: member.id });
    await expect(
      rooms.configureAgent(member.id, {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: searchAgent.id,
        participation: "active",
        toolPermissions: ["search"],
      }),
    ).resolves.toMatchObject({ id: room.id });
    await expect(
      rooms.removeMember(member.id, room.id, invitee.id),
    ).resolves.toMatchObject({ id: room.id });
    await expect(rooms.archiveRoom(member.id, room.id)).resolves.toMatchObject({
      status: "archived",
    });
  });

  it("allows only the owner to change a current non-owner human role", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Role authority" });
    await addHumanMember(rooms, room.id, admin.id);
    await addHumanMember(rooms, room.id, member.id);
    await rooms.setHumanRole(owner.id, room.id, admin.id, "admin");

    await expect(
      rooms.setHumanRole(admin.id, room.id, member.id, "admin"),
    ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    await expect(
      rooms.setHumanRole(member.id, room.id, admin.id, "member"),
    ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    await expect(
      rooms.setHumanRole(owner.id, room.id, owner.id, "member"),
    ).rejects.toMatchObject({ status: 409, code: "room_owner_required" });

    await rooms.configureAgent(owner.id, {
      kind: "agent-configuration",
      roomId: room.id,
      agentId: searchAgent.id,
      participation: "silent",
      toolPermissions: ["search"],
    });
    await expect(
      rooms.setHumanRole(owner.id, room.id, searchAgent.id, "admin"),
    ).rejects.toMatchObject({ status: 400, code: "human_member_required" });
  });

  it("restores a promoted admin and its role audit from JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-room-role-"));
    const filePath = join(directory, "rooms.json");
    const options = {
      actors,
      state: createJsonStateStore(filePath, isRoomLifecycleState),
      clock: () => Date.parse("2026-08-09T09:00:00.000Z"),
      idFactory: sequenceFactory("role-restart-entity"),
      tokenFactory: sequenceFactory("role-restart-token"),
    };

    try {
      const rooms = await createRoomLifecycleService(options);
      const room = await rooms.createRoom(owner.id, { name: "Role restart" });
      await addHumanMember(rooms, room.id, member.id);
      await rooms.setHumanRole(owner.id, room.id, member.id, "admin");

      const restarted = await createRoomLifecycleService({
        ...options,
        state: createJsonStateStore(filePath, isRoomLifecycleState),
      });
      expect(restarted.getRoom(room.id)?.members).toContainEqual(
        expect.objectContaining({ actorId: member.id, role: "admin" }),
      );
      expect(restarted.audit(room.id)).toContainEqual(
        expect.objectContaining({
          type: "room.member.role.changed",
          targetActorId: member.id,
          role: "admin",
        }),
      );
      await expect(
        restarted.renameRoom(member.id, room.id, "Admin survived restart"),
      ).resolves.toMatchObject({ name: "Admin survived restart" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("clamps existing-room mutation time when the wall clock rolls backward", async () => {
    let now = Date.parse("2026-08-09T08:00:00.000Z");
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService({
      ...createOptions(store),
      clock: () => now,
    });
    const room = await rooms.createRoom(owner.id, { name: "Clock rollback" });

    now = Date.parse("2026-08-09T10:00:00.000Z");
    await rooms.renameRoom(owner.id, room.id, "Future rename");
    now = Date.parse("2026-08-09T09:00:00.000Z");

    await expect(
      rooms.renameRoom(owner.id, room.id, "Rollback rename"),
    ).resolves.toMatchObject({ name: "Rollback rename" });
    expect(
      rooms.audit(room.id).slice(-2).map((record) => record.timestamp),
    ).toEqual([
      "2026-08-09T10:00:00.000Z",
      "2026-08-09T10:00:00.000Z",
    ]);
    expect(isRoomLifecycleState(store.current)).toBe(true);
  });

  it("clamps mutation time to future persisted authority after a JSON restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-room-clock-"));
    const filePath = join(directory, "rooms.json");
    let now = Date.parse("2026-08-09T08:00:00.000Z");
    const idFactory = sequenceFactory("clock-restart-entity");
    const tokenFactory = sequenceFactory("clock-restart-token");
    const options = {
      actors,
      clock: () => now,
      idFactory,
      tokenFactory,
    };

    try {
      const rooms = await createRoomLifecycleService({
        ...options,
        state: createJsonStateStore(filePath, isRoomLifecycleState),
      });
      const room = await rooms.createRoom(owner.id, { name: "Restart clock" });
      now = Date.parse("2026-08-09T10:00:00.000Z");
      await rooms.renameRoom(owner.id, room.id, "Future persisted rename");

      now = Date.parse("2026-08-09T09:00:00.000Z");
      const restarted = await createRoomLifecycleService({
        ...options,
        state: createJsonStateStore(filePath, isRoomLifecycleState),
      });
      await expect(
        restarted.renameRoom(owner.id, room.id, "Restarted rollback rename"),
      ).resolves.toMatchObject({ name: "Restarted rollback rename" });
      expect(restarted.audit(room.id).at(-1)?.timestamp).toBe(
        "2026-08-09T10:00:00.000Z",
      );

      const loadedAgain = await createRoomLifecycleService({
        ...options,
        state: createJsonStateStore(filePath, isRoomLifecycleState),
      });
      expect(loadedAgain.getRoom(room.id)?.name).toBe(
        "Restarted rollback rename",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { description: "null input", input: null },
    { description: "numeric input", input: 42 },
    { description: "missing name", input: {} },
    { description: "numeric name", input: { name: 42 } },
    { description: "empty name", input: { name: "" } },
    { description: "whitespace name", input: { name: "   " } },
  ])("rejects createRoom $description with a stable typed error", async ({ input }) => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService(createOptions(store));
    const operation = rooms.createRoom(
      owner.id,
      input as unknown as { readonly name: string },
    );

    await expect(operation).rejects.toBeInstanceOf(RoomLifecycleError);
    await expect(operation).rejects.toMatchObject({
      status: 400,
      code: "room_name_invalid",
    });
    expect(store.current).toBeUndefined();
  });

  it.each([
    { description: "null", name: null },
    { description: "numeric", name: 42 },
    { description: "empty", name: "" },
    { description: "whitespace", name: "   " },
  ])("rejects a $description rename before mutation", async ({ name }) => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService(createOptions(store));
    const room = await rooms.createRoom(owner.id, { name: "Original name" });
    const persistedBeforeRename = store.current;
    const auditBeforeRename = rooms.audit(room.id);
    const operation = rooms.renameRoom(
      owner.id,
      room.id,
      name as unknown as string,
    );

    await expect(operation).rejects.toBeInstanceOf(RoomLifecycleError);
    await expect(operation).rejects.toMatchObject({
      status: 400,
      code: "room_name_invalid",
    });
    expect(store.current).toBe(persistedBeforeRename);
    expect(rooms.getRoom(room.id)?.name).toBe("Original name");
    expect(rooms.audit(room.id)).toEqual(auditBeforeRename);
  });

  it("authorizes rename before validating its name", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Protected name" });
    await addHumanMember(rooms, room.id, member.id);

    await expect(
      rooms.renameRoom(member.id, room.id, 42 as unknown as string),
    ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    expect(rooms.getRoom(room.id)?.name).toBe("Protected name");
  });

  it("stores a trimmed valid room name", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "  Trimmed room  " });
    await expect(
      rooms.renameRoom(owner.id, room.id, "  Trimmed rename  "),
    ).resolves.toMatchObject({ name: "Trimmed rename" });
  });

  it("rejects an actor ID emitted as a room ID before persistence", async () => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService({
      ...createOptions(store),
      idFactory: valuesFactory([owner.id]),
    });

    await expect(
      rooms.createRoom(owner.id, { name: "Colliding room" }),
    ).rejects.toMatchObject({ status: 409, code: "lifecycle_id_conflict" });
    expect(store.current).toBeUndefined();
    expect(rooms.getRoom(owner.id)).toBeUndefined();
  });

  it.each([
    {
      description: "room audit ID",
      ids: ["generated-room", admin.id],
      invitation: false,
    },
    {
      description: "invitation ID",
      ids: ["generated-room", "generated-create-audit", invitee.id],
      invitation: true,
    },
    {
      description: "invitation audit ID",
      ids: [
        "generated-room",
        "generated-create-audit",
        "generated-invitation",
        searchAgent.id,
      ],
      invitation: true,
    },
  ])("rejects an actor ID emitted as a $description", async ({ ids, invitation }) => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService({
      ...createOptions(store),
      idFactory: valuesFactory(ids),
    });

    if (!invitation) {
      await expect(
        rooms.createRoom(owner.id, { name: "Audit collision" }),
      ).rejects.toMatchObject({ status: 409, code: "lifecycle_id_conflict" });
      expect(store.current).toBeUndefined();
      return;
    }

    const room = await rooms.createRoom(owner.id, { name: "Invite collision" });
    const stateBeforeInvite = store.current;
    await expect(
      rooms.inviteHuman(owner.id, {
        kind: "human-invitation",
        roomId: room.id,
        inviteeActorId: invitee.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "lifecycle_id_conflict" });
    expect(store.current).toBe(stateBeforeInvite);
    expect(store.current?.invitations).toEqual([]);
  });

  it("rejects a room/audit cross-kind ID collision deterministically", async () => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService({
      ...createOptions(store),
      idFactory: valuesFactory(["same-entity-id", "same-entity-id"]),
    });

    await expect(
      rooms.createRoom(owner.id, { name: "Cross-kind collision" }),
    ).rejects.toMatchObject({ status: 409, code: "lifecycle_id_conflict" });
    expect(store.current).toBeUndefined();
  });

  it("persists targeted human invitation decisions without raw tokens and restores them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-room-restart-"));
    const filePath = join(directory, "rooms.json");
    const tokenFactory = sequenceFactory("restart-invite-secret");
    const options = {
      actors,
      state: createJsonStateStore(filePath, isRoomLifecycleState),
      clock: () => Date.parse("2026-08-09T08:00:00.000Z"),
      idFactory: sequenceFactory("restart-entity"),
      tokenFactory,
    };

    try {
      const rooms = await createRoomLifecycleService(options);
      const room = await rooms.createRoom(owner.id, { name: "Alpha room" });
      expect(room.members).toEqual([humanMembership(owner.id, "owner")]);

      const acceptedInvitation = await rooms.inviteHuman(owner.id, {
        kind: "human-invitation",
        roomId: room.id,
        inviteeActorId: invitee.id,
      });
      expect(rooms.getRoom(room.id)?.members).toHaveLength(1);
      const persistedPending = await readFile(filePath, "utf8");
      expect(persistedPending).toContain(
        createHash("sha256")
          .update(acceptedInvitation.token)
          .digest("base64url"),
      );
      expect(persistedPending).not.toContain(acceptedInvitation.token);
      expect(persistedPending).not.toContain('"token"');

      await expect(
        rooms.respondToHumanInvitation(member.id, acceptedInvitation.token, "accept"),
      ).rejects.toMatchObject({ status: 403, code: "invitation_forbidden" });
      await expect(
        rooms.respondToHumanInvitation(invitee.id, acceptedInvitation.token, "accept"),
      ).resolves.toMatchObject({
        inviterActorId: owner.id,
        inviteeActorId: invitee.id,
        status: "accepted",
      });
      expect(rooms.getRoom(room.id)?.members).toContainEqual(
        humanMembership(invitee.id, "member"),
      );
      await expect(
        rooms.respondToHumanInvitation(invitee.id, acceptedInvitation.token, "accept"),
      ).rejects.toMatchObject({ status: 409, code: "invitation_consumed" });

      const rejectedInvitation = await rooms.inviteHuman(owner.id, {
        kind: "human-invitation",
        roomId: room.id,
        inviteeActorId: admin.id,
      });
      await expect(
        rooms.respondToHumanInvitation(admin.id, rejectedInvitation.token, "reject"),
      ).resolves.toMatchObject({ status: "rejected" });
      expect(rooms.canAccess(admin.id, room.id)).toBe(false);

      const restarted = await createRoomLifecycleService({
        ...options,
        state: createJsonStateStore(filePath, isRoomLifecycleState),
      });
      expect(restarted.getRoom(room.id)).toMatchObject({
        name: "Alpha room",
        members: expect.arrayContaining([
          expect.objectContaining({ actorId: owner.id, role: "owner" }),
          expect.objectContaining({ actorId: invitee.id, role: "member" }),
        ]),
      });
      await expect(
        restarted.respondToHumanInvitation(
          admin.id,
          rejectedInvitation.token,
          "accept",
        ),
      ).rejects.toMatchObject({ status: 409, code: "invitation_consumed" });
      expect(restarted.audit(room.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "room.invitation.accepted",
            actorId: invitee.id,
            inviterActorId: owner.id,
            result: "accepted",
          }),
          expect.objectContaining({
            type: "room.invitation.rejected",
            actorId: admin.id,
            inviterActorId: owner.id,
            result: "rejected",
          }),
        ]),
      );
      await restarted.renameRoom(owner.id, room.id, "Alpha after restart");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("configures agents immediately with a duplicate-free permission subset", async () => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService(createOptions(store));
    const room = await rooms.createRoom(owner.id, { name: "Agent room" });

    await expect(
      rooms.configureAgent(owner.id, {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: searchAgent.id,
        participation: "active",
        toolPermissions: ["search"],
      }),
    ).resolves.toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          kind: "agent",
          actorId: searchAgent.id,
          participation: "active",
          toolPermissions: ["search"],
        }),
      ]),
    });
    expect(store.current?.invitations).toEqual([]);
    expect(rooms.messageRoom(room.id)?.memberIds).toContain(searchAgent.id);

    await rooms.configureAgent(owner.id, {
      kind: "agent-configuration",
      roomId: room.id,
      agentId: searchAgent.id,
      participation: "on-mention",
      toolPermissions: ["summarize"],
    });
    expect(
      rooms.getRoom(room.id)?.members.filter(
        (membership) => membership.actorId === searchAgent.id,
      ),
    ).toEqual([
      expect.objectContaining({
        participation: "on-mention",
        toolPermissions: ["summarize"],
      }),
    ]);

    for (const request of [
      {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: searchAgent.id,
        participation: "active",
        toolPermissions: [],
      },
      {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: searchAgent.id,
        participation: "active",
        toolPermissions: ["search", "search"],
      },
      {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: searchAgent.id,
        participation: "active",
        toolPermissions: ["shell"],
      },
    ] as const) {
      await expect(rooms.configureAgent(owner.id, request)).rejects.toMatchObject({
        status: 400,
        code: "agent_permissions_invalid",
      });
    }
    await expect(
      rooms.configureAgent(owner.id, {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: member.id,
        participation: "active",
        toolPermissions: [],
      }),
    ).rejects.toMatchObject({ status: 400, code: "agent_required" });
    await expect(
      rooms.configureAgent(owner.id, {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: "agent-missing",
        participation: "active",
        toolPermissions: [],
      }),
    ).rejects.toMatchObject({ status: 404, code: "actor_not_found" });

    const missingParticipation = {
      kind: "agent-configuration",
      roomId: room.id,
      agentId: searchAgent.id,
      toolPermissions: ["search"],
    } as unknown as AgentConfigurationRequest;
    await expect(
      rooms.configureAgent(owner.id, missingParticipation),
    ).rejects.toMatchObject({ status: 400, code: "agent_configuration_invalid" });
  });

  it("restores the latest agent reconfiguration and its complete audits from JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-room-agent-"));
    const filePath = join(directory, "rooms.json");
    let now = Date.parse("2026-08-09T10:00:00.000Z");
    const options = {
      actors,
      state: createJsonStateStore(filePath, isRoomLifecycleState),
      clock: () => now,
      idFactory: sequenceFactory("agent-restart-entity"),
      tokenFactory: sequenceFactory("agent-restart-token"),
    };

    try {
      const rooms = await createRoomLifecycleService(options);
      const room = await rooms.createRoom(owner.id, { name: "Agent restart" });
      now += 1_000;
      await rooms.configureAgent(owner.id, {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: searchAgent.id,
        participation: "active",
        toolPermissions: ["search"],
      });
      now += 1_000;
      await rooms.configureAgent(owner.id, {
        kind: "agent-configuration",
        roomId: room.id,
        agentId: searchAgent.id,
        participation: "silent",
        toolPermissions: ["summarize"],
      });

      const restarted = await createRoomLifecycleService({
        ...options,
        state: createJsonStateStore(filePath, isRoomLifecycleState),
      });
      expect(restarted.getRoom(room.id)?.members).toContainEqual(
        expect.objectContaining({
          kind: "agent",
          actorId: searchAgent.id,
          participation: "silent",
          toolPermissions: ["summarize"],
          configuredAt: "2026-08-09T10:00:02.000Z",
        }),
      );
      expect(
        restarted
          .audit(room.id)
          .filter((record) => record.type === "room.agent.configured"),
      ).toEqual([
        expect.objectContaining({
          targetActorId: searchAgent.id,
          participation: "active",
          toolPermissions: ["search"],
          timestamp: "2026-08-09T10:00:01.000Z",
        }),
        expect.objectContaining({
          targetActorId: searchAgent.id,
          participation: "silent",
          toolPermissions: ["summarize"],
          timestamp: "2026-08-09T10:00:02.000Z",
        }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects every manager action from an ordinary member with room_forbidden", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Governed" });
    await addHumanMember(rooms, room.id, member.id);

    const actions = [
      () => rooms.renameRoom(member.id, room.id, "Forged"),
      () => rooms.archiveRoom(member.id, room.id),
      () =>
        rooms.inviteHuman(member.id, {
          kind: "human-invitation" as const,
          roomId: room.id,
          inviteeActorId: invitee.id,
        }),
      () => rooms.removeMember(member.id, room.id, owner.id),
      () =>
        rooms.configureAgent(member.id, {
          kind: "agent-configuration" as const,
          roomId: room.id,
          agentId: searchAgent.id,
          participation: "active" as const,
          toolPermissions: ["search"],
        }),
    ];

    for (const action of actions) {
      await expect(action()).rejects.toMatchObject({
        status: 403,
        code: "room_forbidden",
      });
    }
    expect(rooms.getRoom(room.id)?.name).toBe("Governed");
  });

  it("allows an existing human admin to execute every manager action", async () => {
    const store = new MemoryRoomStore(adminFixture());
    const rooms = await createRoomLifecycleService({
      ...createOptions(store),
      clock: () => Date.parse("2026-08-09T09:00:00.000Z"),
    });

    await expect(
      rooms.renameRoom(admin.id, "fixture-room", "Admin renamed"),
    ).resolves.toMatchObject({ name: "Admin renamed" });
    await expect(
      rooms.inviteHuman(admin.id, {
        kind: "human-invitation",
        roomId: "fixture-room",
        inviteeActorId: invitee.id,
      }),
    ).resolves.toMatchObject({ inviteeActorId: invitee.id });
    await expect(
      rooms.configureAgent(admin.id, {
        kind: "agent-configuration",
        roomId: "fixture-room",
        agentId: searchAgent.id,
        participation: "silent",
        toolPermissions: ["search"],
      }),
    ).resolves.toMatchObject({ id: "fixture-room" });
    await expect(
      rooms.removeMember(admin.id, "fixture-room", member.id),
    ).resolves.toMatchObject({
      members: expect.not.arrayContaining([
        expect.objectContaining({ actorId: member.id }),
      ]),
    });
    await expect(
      rooms.archiveRoom(admin.id, "fixture-room"),
    ).resolves.toMatchObject({ status: "archived" });
  });

  it("removes access immediately while preserving evidence and explicit idempotency", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Removal room" });
    await addHumanMember(rooms, room.id, member.id);
    const auditBeforeRemoval = rooms.audit(room.id);

    await rooms.removeMember(owner.id, room.id, member.id);
    expect(rooms.canAccess(member.id, room.id)).toBe(false);
    expect(rooms.canAccess("human-missing", room.id)).toBe(false);
    expect(rooms.canAccess(owner.id, "room-missing")).toBe(false);
    expect(rooms.audit(room.id).slice(0, auditBeforeRemoval.length)).toEqual(
      auditBeforeRemoval,
    );
    expect(rooms.audit(room.id)).toContainEqual(
      expect.objectContaining({
        type: "room.member.removed",
        actorId: owner.id,
        targetActorId: member.id,
        result: "removed",
      }),
    );
    await expect(
      rooms.removeMember(owner.id, room.id, member.id),
    ).rejects.toMatchObject({ status: 404, code: "room_member_not_found" });
    await expect(
      rooms.removeMember(owner.id, room.id, owner.id),
    ).rejects.toMatchObject({ status: 409, code: "room_owner_required" });
  });

  it("makes archive durable, access-closing, mutation-blocking, and idempotent", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Archive room" });
    await addHumanMember(rooms, room.id, member.id);
    const pending = await rooms.inviteHuman(owner.id, {
      kind: "human-invitation",
      roomId: room.id,
      inviteeActorId: invitee.id,
    });
    const archived = await rooms.archiveRoom(owner.id, room.id);
    const auditAfterArchive = rooms.audit(room.id);

    expect(archived.status).toBe("archived");
    expect(rooms.canAccess(owner.id, room.id)).toBe(false);
    expect(rooms.messageRoom(room.id)).toBeUndefined();
    await expect(rooms.archiveRoom(owner.id, room.id)).resolves.toEqual(archived);
    expect(rooms.audit(room.id)).toEqual(auditAfterArchive);

    for (const action of [
      () => rooms.renameRoom(owner.id, room.id, "After archive"),
      () =>
        rooms.inviteHuman(owner.id, {
          kind: "human-invitation" as const,
          roomId: room.id,
          inviteeActorId: admin.id,
        }),
      () => rooms.removeMember(owner.id, room.id, member.id),
      () =>
        rooms.configureAgent(owner.id, {
          kind: "agent-configuration" as const,
          roomId: room.id,
          agentId: searchAgent.id,
          participation: "active" as const,
          toolPermissions: ["search"],
        }),
      () => rooms.respondToHumanInvitation(invitee.id, pending.token, "accept"),
    ]) {
      await expect(action()).rejects.toMatchObject({
        status: 409,
        code: "room_archived",
      });
    }

    await expect(
      rooms.respondToHumanInvitation(invitee.id, pending.token, "reject"),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(rooms.audit(room.id)).toContainEqual(
      expect.objectContaining({
        type: "room.invitation.rejected",
        targetActorId: invitee.id,
        result: "rejected",
      }),
    );
  });

  it("publishes no mutation or audit record when persistence fails", async () => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService(createOptions(store));
    const room = await rooms.createRoom(owner.id, { name: "Original" });
    const auditBefore = rooms.audit(room.id);
    const persistenceError = new Error("room persistence failed");

    store.failNextSave(persistenceError);
    await expect(
      rooms.renameRoom(owner.id, room.id, "Must not publish"),
    ).rejects.toBe(persistenceError);
    expect(rooms.getRoom(room.id)?.name).toBe("Original");
    expect(rooms.audit(room.id)).toEqual(auditBefore);

    await expect(
      rooms.renameRoom(owner.id, room.id, "Retry works"),
    ).resolves.toMatchObject({ name: "Retry works" });
  });

  it("serializes concurrent mutations and consumes an invitation exactly once", async () => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService(createOptions(store));
    const [first, second] = await Promise.all([
      rooms.createRoom(owner.id, { name: "First" }),
      rooms.createRoom(admin.id, { name: "Second" }),
    ]);
    expect(store.current?.rooms).toHaveLength(2);
    expect(rooms.getRoom(first.id)?.name).toBe("First");
    expect(rooms.getRoom(second.id)?.name).toBe("Second");

    const issued = await rooms.inviteHuman(owner.id, {
      kind: "human-invitation",
      roomId: first.id,
      inviteeActorId: invitee.id,
    });
    const decisions = await Promise.allSettled([
      rooms.respondToHumanInvitation(invitee.id, issued.token, "accept"),
      rooms.respondToHumanInvitation(invitee.id, issued.token, "reject"),
    ]);
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(decisions.filter((decision) => decision.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      rooms
        .getRoom(first.id)
        ?.members.filter((membership) => membership.actorId === invitee.id),
    ).toHaveLength(1);
  });

  it("reports initialization rejection through the factory without an unhandled load", async () => {
    const loadError = new Error("room load failed");
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const servicePromise = createRoomLifecycleService({
        ...createOptions(new MemoryRoomStore()),
        state: {
          async load() {
            throw loadError;
          },
          async save() {
            throw new Error("save must not run");
          },
        },
      });
      const rejection = expect(servicePromise).rejects.toBe(loadError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledReasons).toEqual([]);
      await rejection;
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("returns detached views so callers cannot mutate authority state", async () => {
    const rooms = await createRoomLifecycleService(
      createOptions(new MemoryRoomStore()),
    );
    const room = await rooms.createRoom(owner.id, { name: "Detached" });
    const leaked = rooms.getRoom(room.id) as ManagedRoom;
    (leaked as { name: string }).name = "Tampered";
    (leaked.members as unknown as unknown[]).length = 0;

    expect(rooms.getRoom(room.id)).toMatchObject({
      name: "Detached",
      members: [expect.objectContaining({ actorId: owner.id })],
    });
  });

  it("does not let a retaining state store mutate published authority", async () => {
    const store = new MemoryRoomStore();
    const rooms = await createRoomLifecycleService(createOptions(store));
    const room = await rooms.createRoom(owner.id, { name: "Detached store" });
    const retained = store.current as unknown as {
      rooms: { name: string; members: unknown[] }[];
    };
    const retainedRoom = retained.rooms[0];
    if (retainedRoom === undefined) {
      throw new Error("fixture room was not persisted");
    }
    retainedRoom.name = "Store tampered";
    retainedRoom.members.length = 0;

    expect(rooms.getRoom(room.id)).toMatchObject({
      name: "Detached store",
      members: [expect.objectContaining({ actorId: owner.id })],
    });
  });
});
