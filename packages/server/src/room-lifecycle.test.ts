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
) {
  return {
    kind: "human" as const,
    actorId,
    role,
    joinedAt: "2026-08-09T08:00:00.000Z",
  };
}

function adminFixture(): RoomLifecycleState {
  return {
    version: 1,
    actors,
    rooms: [
      {
        id: "fixture-room",
        name: "Fixture",
        status: "active",
        members: [
          humanMembership(owner.id, "owner"),
          humanMembership(admin.id, "admin"),
          humanMembership(member.id, "member"),
        ],
        createdAt: "2026-08-09T08:00:00.000Z",
      },
    ],
    invitations: [],
    audit: [],
  };
}

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
    ...adminFixture(),
    invitations: [invitation],
    audit:
      status === "pending"
        ? [issuanceAudit]
        : [issuanceAudit, decisionAudit],
  };
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
        const audit = state.audit as Record<string, unknown>[];
        audit[1] = {
          ...audit[1],
          type: "room.invitation.rejected",
          result: "rejected",
        };
      },
    },
    {
      description: "orphan decision audit",
      mutate(state: Record<string, unknown>) {
        const audit = state.audit as Record<string, unknown>[];
        audit[1] = { ...audit[1], invitationId: "invitation-missing" };
      },
    },
    {
      description: "duplicate decision audit",
      mutate(state: Record<string, unknown>) {
        const audit = state.audit as Record<string, unknown>[];
        audit.push({ ...audit[1], id: "audit-invitation-decided-again" });
      },
    },
    {
      description: "decision audit by the wrong actor",
      mutate(state: Record<string, unknown>) {
        const audit = state.audit as Record<string, unknown>[];
        audit[1] = { ...audit[1], actorId: admin.id };
      },
    },
    {
      description: "decision audit for the wrong existing room",
      mutate(state: Record<string, unknown>) {
        const fixtureRooms = state.rooms as Record<string, unknown>[];
        fixtureRooms.push({ ...fixtureRooms[0], id: "fixture-room-other" });
        const audit = state.audit as Record<string, unknown>[];
        audit[1] = { ...audit[1], roomId: "fixture-room-other" };
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
    (candidate.audit as unknown[]).push((terminal.audit as unknown[])[1]);
    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it("rejects a terminal decision timestamp before invitation issuance", () => {
    const candidate = invitationAuthorityFixture("accepted");
    const invitations = candidate.invitations as Record<string, unknown>[];
    invitations[0] = {
      ...invitations[0],
      decidedAt: "2026-08-09T07:59:00.000Z",
    };
    const audit = candidate.audit as Record<string, unknown>[];
    audit[1] = {
      ...audit[1],
      timestamp: "2026-08-09T07:59:00.000Z",
    };

    expect(isRoomLifecycleState(candidate)).toBe(false);
  });

  it.each([
    {
      description: "missing issuance audit",
      mutate(state: Record<string, unknown>) {
        (state.audit as unknown[]).shift();
      },
    },
    {
      description: "orphan issuance audit",
      mutate(state: Record<string, unknown>) {
        const audit = state.audit as Record<string, unknown>[];
        audit[0] = { ...audit[0], invitationId: "invitation-missing" };
      },
    },
    {
      description: "issuance audit with a mismatched inviter",
      mutate(state: Record<string, unknown>) {
        const audit = state.audit as Record<string, unknown>[];
        audit[0] = { ...audit[0], actorId: admin.id };
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
        const audit = state.audit as Record<string, unknown>[];
        audit[1] = {
          ...audit[1],
          type: "room.invitation.rejected",
          result: "rejected",
        };
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
        const audit = state.audit as Record<string, unknown>[];
        audit[1] = { ...audit[1], invitationId: "invitation-missing" };
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
        const audit = state.audit as Record<string, unknown>[];
        audit[0] = { ...audit[0], invitationId: admin.id };
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
        const audit = state.audit as Record<string, unknown>[];
        audit[0] = { ...audit[0], invitationId: "fixture-room" };
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
    const rooms = await createRoomLifecycleService(createOptions(store));

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
