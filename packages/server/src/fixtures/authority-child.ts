import {
  isActor,
  isLegacyAgentExecution,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isHumanRoomMembership,
  isMessage,
  isOpenItem,
  type Actor,
  type AgentRuntimeProviderInput,
  type ProviderEvent,
} from "@native-im/core";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { IdentityAdapter, LoginCredentials } from "../auth.js";
import { PRODUCTION_CLAMD_POLICY } from "../attachment-authority/production-capabilities.js";
import { mintInternalAgentCommandContext } from "../persistence/contracts.js";
import { createLegacyMessageAuthorityInserter } from
  "../persistence/message-authority-legacy-adapter.js";
import { createWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import {
  startAuthoritativeServer,
  startAuthoritativeServerForTest,
  type StartAuthoritativeServerOptions,
} from "../authoritative-server.js";
import type { ProviderAdapter } from "../agent-runtime/contracts.js";

interface AuthorityChildStartCommand {
  readonly type: "start";
  readonly databasePath: string;
  readonly snapshotCachePath: string;
  readonly actors: readonly Actor[];
  readonly identity: {
    readonly accountId: string;
    readonly actorId: string;
    readonly secret: string;
  };
  readonly identities?: readonly {
    readonly accountId: string;
    readonly actorId: string;
    readonly secret: string;
  }[];
  readonly invitationSecretKey: string;
  readonly faultPoint?:
    | "after-domain-write"
    | "before-commit"
    | "after-commit-before-outbox"
    | "after-send-before-dispatch-mark";
  readonly seedAllFacts?: true;
  readonly seedGovernanceRoom?: true;
  readonly forceSnapshotFallback?: true;
  readonly snapshotRecordsPerPage?: number;
  readonly readbackOnly?: true;
  readonly inspectMessageIds?: readonly string[];
  readonly seedMixedRoomId?: string;
  readonly emitUnrelatedWarningForTest?: true;
  readonly closeCleanupProbe?: true;
  readonly seedRuntimeRoomForTest?: true;
  readonly enableAttachmentFixture?: true;
  readonly previewSentinelForTest?: string;
  readonly suppressJsonForTest?: true;
  readonly ignoreSigtermForTest?: true;
  readonly compactRoom?: {
    readonly roomId: string;
    readonly retainedFromSeq: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isStartCommand(value: unknown): value is AuthorityChildStartCommand {
  if (!isRecord(value)) return false;
  const keys = [
    "type",
    "databasePath",
    "snapshotCachePath",
    "actors",
    "identity",
    ...(value.identities === undefined ? [] : ["identities"]),
    "invitationSecretKey",
    ...(value.faultPoint === undefined ? [] : ["faultPoint"]),
    ...(value.seedAllFacts === undefined ? [] : ["seedAllFacts"]),
    ...(value.seedGovernanceRoom === undefined ? [] : ["seedGovernanceRoom"]),
    ...(value.forceSnapshotFallback === undefined ? [] : ["forceSnapshotFallback"]),
    ...(value.snapshotRecordsPerPage === undefined ? [] : ["snapshotRecordsPerPage"]),
    ...(value.readbackOnly === undefined ? [] : ["readbackOnly"]),
    ...(value.inspectMessageIds === undefined ? [] : ["inspectMessageIds"]),
    ...(value.seedMixedRoomId === undefined ? [] : ["seedMixedRoomId"]),
    ...(value.emitUnrelatedWarningForTest === undefined ? [] : ["emitUnrelatedWarningForTest"]),
    ...(value.closeCleanupProbe === undefined ? [] : ["closeCleanupProbe"]),
    ...(value.seedRuntimeRoomForTest === undefined ? [] : ["seedRuntimeRoomForTest"]),
    ...(value.enableAttachmentFixture === undefined ? [] : ["enableAttachmentFixture"]),
    ...(value.previewSentinelForTest === undefined ? [] : ["previewSentinelForTest"]),
    ...(value.suppressJsonForTest === undefined ? [] : ["suppressJsonForTest"]),
    ...(value.ignoreSigtermForTest === undefined ? [] : ["ignoreSigtermForTest"]),
    ...(value.compactRoom === undefined ? [] : ["compactRoom"]),
  ];
  if (!exactKeys(value, keys) || value.type !== "start" ||
      typeof value.databasePath !== "string" || value.databasePath.length === 0 ||
      typeof value.snapshotCachePath !== "string" || value.snapshotCachePath.length === 0 ||
      !Array.isArray(value.actors) || !isRecord(value.identity) ||
      !exactKeys(value.identity, ["accountId", "actorId", "secret"]) ||
      typeof value.identity.accountId !== "string" || value.identity.accountId.length === 0 ||
      typeof value.identity.actorId !== "string" || value.identity.actorId.length === 0 ||
      typeof value.identity.secret !== "string" || value.identity.secret.length === 0 ||
      (value.identities !== undefined && (!Array.isArray(value.identities) ||
        value.identities.length === 0 || value.identities.some((identity) =>
          !isRecord(identity) || !exactKeys(identity, ["accountId", "actorId", "secret"]) ||
          typeof identity.accountId !== "string" || identity.accountId.length === 0 ||
          typeof identity.actorId !== "string" || identity.actorId.length === 0 ||
          typeof identity.secret !== "string" || identity.secret.length === 0))) ||
      typeof value.invitationSecretKey !== "string" ||
      (value.seedAllFacts !== undefined && value.seedAllFacts !== true) ||
      (value.seedGovernanceRoom !== undefined && value.seedGovernanceRoom !== true) ||
      (value.seedAllFacts === true && value.seedGovernanceRoom === true) ||
      (value.forceSnapshotFallback !== undefined && value.forceSnapshotFallback !== true) ||
      (value.snapshotRecordsPerPage !== undefined &&
        (!Number.isSafeInteger(value.snapshotRecordsPerPage) ||
          Number(value.snapshotRecordsPerPage) < 1)) ||
      (value.readbackOnly !== undefined && value.readbackOnly !== true) ||
      (value.inspectMessageIds !== undefined &&
        (!Array.isArray(value.inspectMessageIds) ||
          !value.inspectMessageIds.every((id) => typeof id === "string" && id.length > 0))) ||
      (value.seedMixedRoomId !== undefined &&
        (typeof value.seedMixedRoomId !== "string" || value.seedMixedRoomId.length === 0)) ||
      (value.emitUnrelatedWarningForTest !== undefined &&
        value.emitUnrelatedWarningForTest !== true) ||
      (value.closeCleanupProbe !== undefined && value.closeCleanupProbe !== true) ||
      (value.seedRuntimeRoomForTest !== undefined && value.seedRuntimeRoomForTest !== true) ||
      (value.enableAttachmentFixture !== undefined && value.enableAttachmentFixture !== true) ||
      (value.previewSentinelForTest !== undefined &&
        (typeof value.previewSentinelForTest !== "string" ||
          value.previewSentinelForTest.length === 0 ||
          Buffer.byteLength(value.previewSentinelForTest, "utf8") > 1_024)) ||
      (value.suppressJsonForTest !== undefined && value.suppressJsonForTest !== true) ||
      (value.ignoreSigtermForTest !== undefined && value.ignoreSigtermForTest !== true) ||
      (value.compactRoom !== undefined &&
        (!isRecord(value.compactRoom) ||
          !exactKeys(value.compactRoom, ["roomId", "retainedFromSeq"]) ||
          typeof value.compactRoom.roomId !== "string" || value.compactRoom.roomId.length === 0 ||
          !Number.isSafeInteger(value.compactRoom.retainedFromSeq) ||
          Number(value.compactRoom.retainedFromSeq) < 1)) ||
      [value.inspectMessageIds, value.seedMixedRoomId, value.compactRoom]
        .filter((utility) => utility !== undefined).length > 1) {
    return false;
  }
  if ([value.seedAllFacts, value.seedGovernanceRoom, value.seedRuntimeRoomForTest]
      .filter((seed) => seed === true).length > 1) {
    return false;
  }
  return value.faultPoint === undefined ||
    value.faultPoint === "after-domain-write" ||
    value.faultPoint === "before-commit" ||
    value.faultPoint === "after-commit-before-outbox" ||
    value.faultPoint === "after-send-before-dispatch-mark";
}

async function startAttachmentClamdFixture(): Promise<Readonly<{
  endpoint: Readonly<{ kind: "tcp"; host: "127.0.0.1"; port: number }>;
  close(): Promise<void>;
}>> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let mode: "command" | "stream" = "command";
    let scannedBytes = 0;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (mode === "command") {
        const terminator = buffer.indexOf(0);
        if (terminator === -1) {
          if (buffer.byteLength > 32) socket.destroy();
          return;
        }
        const command = buffer.subarray(0, terminator + 1).toString("latin1");
        buffer = buffer.subarray(terminator + 1);
        if (command === "zVERSION\0") {
          socket.end("ClamAV 1.5.3/fixture-db/Thu Jan 01 00:00:00 2026\0");
          return;
        }
        if (command !== "zINSTREAM\0") {
          socket.destroy();
          return;
        }
        mode = "stream";
      }
      while (mode === "stream" && buffer.byteLength >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length > 1 * 1_024 * 1_024) {
          socket.destroy();
          return;
        }
        if (length === 0) {
          buffer = buffer.subarray(4);
          if (buffer.byteLength !== 0 || scannedBytes === 0) socket.destroy();
          else socket.end(
            "FT04_E2E_SCANNER_RAW_SIGNATURE /private/ft04-e2e/clamd.sock " +
            "FT04_E2E_BEARER_TOKEN: OK\0",
          );
          return;
        }
        if (buffer.byteLength < 4 + length) return;
        scannedBytes += length;
        if (scannedBytes > 50 * 1_024 * 1_024) {
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Attachment ClamD fixture did not bind loopback TCP");
  }
  return Object.freeze({
    endpoint: Object.freeze({ kind: "tcp" as const, host: "127.0.0.1" as const, port: address.port }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  });
}

async function readClosedStartupCommand(): Promise<AuthorityChildStartCommand> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += Buffer.from(chunk as Uint8Array).toString("utf8");
    if (Buffer.byteLength(input, "utf8") > 256 * 1_024) {
      throw new TypeError("Authority child startup command is too large");
    }
  }
  const lines = input.split("\n");
  if (lines.length !== 2 || lines[1] !== "") {
    throw new TypeError("Authority child requires one newline-terminated command");
  }
  const parsed = JSON.parse(lines[0] ?? "") as unknown;
  if (!isStartCommand(parsed)) {
    throw new TypeError("Authority child startup command is invalid");
  }
  return parsed;
}

function inspectAuthority(
  databasePath: string,
  messageIds: readonly string[],
): Record<string, unknown> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const actors = database.prepare(
      `SELECT id, kind, display_name AS displayName, reachability, readiness,
              tool_permissions_json AS toolPermissionsJson
       FROM actors ORDER BY id`,
    ).all().map((row) => row.kind === "human"
      ? { id: row.id, kind: row.kind, displayName: row.displayName,
          reachability: row.reachability }
      : { id: row.id, kind: row.kind, displayName: row.displayName,
          readiness: row.readiness,
          toolPermissions: JSON.parse(String(row.toolPermissionsJson)) });
    const commandRows = messageIds.map((messageId) => {
      const message = database.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE id = ?",
      ).get(messageId) as { readonly count: number };
      const events = database.prepare(
        "SELECT event_id AS eventId FROM events WHERE event_type = 'room.message.accepted' AND json_extract(payload_json, '$.id') = ?",
      ).all(messageId) as Array<{ readonly eventId: string }>;
      const idempotency = database.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_records WHERE key = ?",
      ).get(messageId) as { readonly count: number };
      const outbox = events.length === 0
        ? { count: 0 }
        : database.prepare(
            "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE event_id = ?",
          ).get(events[0]!.eventId) as { readonly count: number };
      return {
        messageId,
        messages: message.count,
        events: events.length,
        idempotency: idempotency.count,
        outbox: outbox.count,
        eventIds: events.map((event) => event.eventId),
      };
    });
    return { type: "inspection", actors, commandRows };
  } finally {
    database.close();
  }
}

function seedMixedRoomRecords(databasePath: string, roomId: string): Record<string, unknown> {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const insertActor = database.prepare(
      `INSERT INTO actors (id, kind, display_name, reachability, readiness,
         tool_permissions_json, catalog_revision)
       VALUES (?, 'human', ?, 'online', NULL, '[]', 0)`,
    );
    const insertIdentityStream = database.prepare(
      "INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES ('identity', ?, 0, 1)",
    );
    const insertMembership = database.prepare(
      `INSERT INTO room_memberships (room_id, actor_id, kind, role, participation,
         tool_permissions_json, joined_at, configured_at, access_revision)
       VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 0)`,
    );
    const insertMessage = createLegacyMessageAuthorityInserter(database);
    const insertRead = database.prepare(
      "INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at) VALUES (?, ?, ?, ?)",
    );
    const insertJudgement = database.prepare(
      `INSERT INTO agent_judgments (id, room_id, agent_id, message_id, judgment_json, created_at)
       VALUES (?, ?, 'agent-a', ?, ?, ?)`,
    );
    const insertOpenItem = database.prepare(
      `INSERT INTO open_items (id, room_id, source_message_id, current_owner_actor_id, status,
         body, created_at, responded_at, requester_actor_id, transfer_chain_json,
         origin_kind, proposal_kind, source_execution_id, proposal_reason)
       VALUES (?, ?, ?, 'human-a', 'awaiting', ?, ?, NULL, 'human-a', '[]',
         'manual_unfinished', NULL, NULL, NULL)`,
    );
    const insertExecution = database.prepare(
      `INSERT INTO agent_executions (id, room_id, agent_id, trigger_message_id, status,
         started_at, completed_at, result_json, requester_actor_id, tool_name,
         action_category, tool_dispatch_phase, queued_at, updated_at)
       VALUES (?, ?, 'agent-a', ?, 'running', ?, NULL, NULL, 'human-a', 'x',
         'tool_call', 'not_started', ?, ?)`,
    );
    const insertInvocationIntent = database.prepare(
      `INSERT INTO agent_invocation_intents (
         id, room_id, source_message_id, target_agent_id, requester_actor_id,
         intent_kind, execution_id, created_at, source_revision, lineage_id,
         turn_id, origin_kind, status, claimed_at
       ) VALUES (?, ?, ?, 'agent-a', 'human-a', 'direct_mention', ?, ?, 1, ?,
                 'legacy', 'legacy_runtime', 'claimed', ?)`,
    );
    const insertExecutionAttempt = database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
         action_category, started_at, recovery_cursor
       ) VALUES (?, 1, 1, 1, 'running', 'tool_call', ?, 0)`,
    );
    const insertExecutionIntentLink = database.prepare(
      `INSERT INTO agent_execution_intent_links (
         intent_id, execution_id, execution_ordinal, retry_of_execution_id,
         source_revision, linked_at
       ) VALUES (?, ?, 1, NULL, 1, ?)`,
    );
    const insertCalibration = database.prepare(
      `INSERT INTO calibration_signals (id, room_id, agent_id, judgment_id, signal,
         created_at, source_message_id, actor_id)
       VALUES (?, ?, 'agent-a', NULL, ?, ?, 'message-agent-authority', 'human-a')`,
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 1_998; index += 1) {
        const suffix = index.toString(36);
        const actor = {
          id: `h${suffix}`,
          kind: "human" as const,
          displayName: `H${suffix}`,
          reachability: "online" as const,
        };
        const membership = {
          kind: "human" as const,
          actorId: actor.id,
          role: "member" as const,
          joinedAt: "t",
        };
        const receipt = {
          id: `human-read:${roomId}:${actor.id}`,
          messageId: "message-human-authority",
          readerId: actor.id,
          readAt: "t",
        };
        if (!isActor(actor) || !isHumanRoomMembership(membership) ||
            !isHumanReadReceipt(receipt)) {
          throw new TypeError("Mixed authority actor fixture is not closed");
        }
        insertActor.run(actor.id, actor.displayName);
        insertIdentityStream.run(actor.id);
        insertMembership.run(roomId, actor.id, membership.joinedAt);
        insertRead.run(roomId, actor.id, receipt.messageId, receipt.readAt);
      }
      for (let index = 0; index < 3_495; index += 1) {
        const suffix = index.toString(36);
        const message = { id: `m${suffix}`, roomId,
          authorId: "human-a", authorKind: "human" as const,
          body: `m${suffix}`, sentAt: "2026-08-12T10:00:00.000Z" };
        if (!isMessage(message)) throw new TypeError("Mixed message fixture is not closed");
        insertMessage(message);
      }
      for (let index = 0; index < 499; index += 1) {
        const suffix = index.toString(36);
        const messageId = `m${index.toString(36)}`;
        const judgment = { id: `j${suffix}`, messageId, agentId: "agent-a",
          outcome: "will_respond" as const, reason: `j${suffix}`,
          decidedAt: "t" };
        const item = { id: `o${suffix}`, roomId, sourceMessageId: messageId,
          requesterId: "human-a", currentOwnerId: "human-a", content: `o${suffix}`,
          status: "awaiting" as const, origin: { kind: "manual_unfinished" as const }, createdAt: "t",
          transferChain: [] };
        const execution = { id: `e${suffix}`, roomId,
          sourceMessageId: messageId, requesterId: "human-a", agentId: "agent-a",
          toolName: "x", status: "running" as const,
          actionCategory: "tool_call" as const,
          toolDispatchPhase: "not_started" as const,
          currentAttemptSeq: 1, retryCycle: 1, retryOrdinal: 1 as const,
          recoveryCursor: 0, queuedAt: "t", startedAt: "t", updatedAt: "t" };
        if (!isAgentJudgement(judgment) || !isOpenItem(item) ||
            !isLegacyAgentExecution(execution)) {
          throw new TypeError("Mixed collaboration fixture is not closed");
        }
        insertJudgement.run(judgment.id, roomId, messageId,
          JSON.stringify(judgment), judgment.decidedAt);
        insertOpenItem.run(item.id, roomId, messageId, item.content, item.createdAt);
        insertExecution.run(
          execution.id,
          roomId,
          messageId,
          execution.startedAt,
          execution.startedAt,
          execution.startedAt,
        );
        const invocationIntentId = `i${suffix}`;
        insertInvocationIntent.run(
          invocationIntentId,
          roomId,
          messageId,
          execution.id,
          execution.startedAt,
          invocationIntentId,
          execution.startedAt,
        );
        insertExecutionAttempt.run(execution.id, execution.startedAt);
        insertExecutionIntentLink.run(invocationIntentId, execution.id, execution.startedAt);
      }
      for (let index = 0; index < 999; index += 1) {
        const suffix = index.toString(36);
        const signal = { id: `c${suffix}`,
          sourceMessageId: "message-agent-authority", actorId: "human-a",
          agentId: "agent-a", emoji: index % 2 === 0 ? "👍" as const : "👎" as const,
          createdAt: "t" };
        if (!isCalibrationSignal(signal)) {
          throw new TypeError("Mixed calibration fixture is not closed");
        }
        insertCalibration.run(signal.id, roomId, signal.emoji, signal.createdAt);
      }
      database.exec("COMMIT");
    } catch (error: unknown) {
      database.exec("ROLLBACK");
      throw error;
    }
    const count = (table: string): number => {
      const row = database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE room_id = ?`,
      ).get(roomId) as { readonly count: number };
      return row.count;
    };
    const routeJudgmentCount = database.prepare(
      `SELECT COUNT(*) AS count
       FROM route_judgments AS judgment
       INNER JOIN route_jobs AS job ON job.id = judgment.route_job_id
       WHERE job.room_id = ?`,
    ).get(roomId) as { readonly count: number };
    const messageRevisionCount = database.prepare(
      `SELECT COUNT(*) AS count
       FROM message_revisions AS revision
       INNER JOIN message_envelopes AS envelope ON envelope.message_id = revision.message_id
       WHERE envelope.room_id = ? AND envelope.lifecycle = 'active'
         AND envelope.message_kind = 'human'
         AND revision.revision <= envelope.current_revision`,
    ).get(roomId) as { readonly count: number };
    const mixedCounts = {
      room: 1,
      membership: count("room_memberships"),
      "timeline-message": count("messages"),
      "message-revision": messageRevisionCount.count,
      "human-read": count("human_read_receipts"),
      "agent-judgement": count("agent_judgments"),
      "open-item": count("open_items"),
      "legacy-agent-execution": count("agent_executions"),
      calibration: count("calibration_signals"),
      "route-job": count("route_jobs"),
      // Legacy static route_job_agents are no longer an authority candidate set.
      // Only judgments already persisted from a closed v20 snapshot count here.
      "route-judgment": routeJudgmentCount.count,
    };
    const distinctMembershipActors = database.prepare(
      "SELECT COUNT(DISTINCT actor_id) AS count FROM room_memberships WHERE room_id = ?",
    ).get(roomId) as { readonly count: number };
    const stream = database.prepare(
      "SELECT head_seq AS watermark FROM streams WHERE stream_kind = 'room' AND stream_id = ?",
    ).get(roomId) as { readonly watermark: number };
    return {
      type: "mixed-seeded",
      mixedCounts,
      total: Object.values(mixedCounts).reduce((sum, value) => sum + value, 0),
      distinctMembershipActors: distinctMembershipActors.count,
      watermark: stream.watermark,
    };
  } finally {
    database.close();
  }
}

const command = await readClosedStartupCommand();
if (command.ignoreSigtermForTest === true) {
  process.on("SIGTERM", () => undefined);
}
if (command.suppressJsonForTest === true) {
  process.stderr.write("authority-child-silent-ready\n");
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
}
if (command.emitUnrelatedWarningForTest === true) {
  process.emitWarning("unrelated fixture warning", { type: "ExperimentalWarning" });
  await new Promise<void>((resolve) => setImmediate(resolve));
}
if (command.inspectMessageIds !== undefined) {
  process.stdout.write(`${JSON.stringify(inspectAuthority(
    command.databasePath,
    command.inspectMessageIds,
  ))}\n`);
  process.exit(0);
}
if (command.seedMixedRoomId !== undefined) {
  process.stdout.write(`${JSON.stringify(seedMixedRoomRecords(
    command.databasePath,
    command.seedMixedRoomId,
  ))}\n`);
  process.exit(0);
}
if (command.compactRoom !== undefined) {
  const database = await createWorkerDatabaseClient({ databasePath: command.databasePath });
  try {
    await database.compactRoomStream(
      command.compactRoom.roomId,
      command.compactRoom.retainedFromSeq,
    );
  } finally {
    await database.close();
  }
  process.stdout.write(`${JSON.stringify({ type: "room-compacted" })}\n`);
  process.exit(0);
}
const identities: IdentityAdapter = {
  async verify(credentials: LoginCredentials) {
    const matched = (command.identities ?? [command.identity]).find((identity) =>
      credentials.accountId === identity.accountId && credentials.secret === identity.secret);
    return matched === undefined
      ? undefined
      : { accountId: matched.accountId, actorId: matched.actorId };
  },
};

async function seedThroughFacades(
  facades: Parameters<NonNullable<Parameters<typeof startAuthoritativeServerForTest>[1]["initialize"]>>[0],
): Promise<void> {
    const issued = await facades.auth.login({
      accountId: command.identity.accountId,
      secret: command.identity.secret,
    });
    const session = await facades.auth.authenticateSession(issued.accessToken);
    const human = (requestId: string) => ({
      ...session,
      kind: "human" as const,
      requestId,
      idempotencyKey: requestId,
    });
    const room = await facades.lifecycle.createRoom(human("seed-room"), {
      name: "Authoritative recovery",
    });
    const roomId = room.id;
    await facades.lifecycle.configureAgent(human("seed-agent-membership"), {
      kind: "agent-configuration",
      roomId,
      agentId: "agent-a",
      participation: "active",
      toolPermissions: ["authority.inspect"],
    });
    await facades.messages.send(human("seed-human-message"), {
      id: "message-human-authority",
      roomId,
      body: "Human durable fact",
      sentAt: "2026-08-12T09:00:00.000Z",
    });
    const agentContext = (requestId: string) => mintInternalAgentCommandContext({
      agentId: "agent-a",
      requestId,
      idempotencyKey: requestId,
    });
    await facades.messages.send(agentContext("seed-agent-message"), {
      id: "message-agent-authority",
      roomId,
      body: "Agent durable fact",
      sentAt: "2026-08-12T09:01:00.000Z",
    });
    await facades.primitives.recordHumanRead(human("seed-human-read"), roomId, {
      messageId: "message-agent-authority",
    });
    await facades.primitives.recordAgentJudgement(
      agentContext("seed-agent-judgement"),
      roomId,
      {
        messageId: "message-human-authority",
        outcome: "will_respond",
        reason: "Authority fixture judged this request",
      },
    );
    await facades.primitives.createOpenItem(human("seed-open-item"), roomId, {
      creationKind: "manual_unfinished",
      sourceMessageId: "message-agent-authority",
      targetActorId: command.identity.actorId,
      content: "Human decision remains open",
    });
    await facades.primitives.transitionAgentExecution(
      agentContext("seed-agent-execution"),
      roomId,
      {
        executionId: "execution-authority",
        sourceMessageId: "message-human-authority",
        toolName: "authority.inspect",
        status: "running",
      },
    );
    await facades.primitives.recordCalibration(human("seed-calibration"), roomId, {
      sourceMessageId: "message-agent-authority",
      emoji: "👍",
    });
}

async function seedGovernanceRoomThroughFacades(
  facades: Parameters<NonNullable<Parameters<typeof startAuthoritativeServerForTest>[1]["initialize"]>>[0],
): Promise<void> {
  const issued = await facades.auth.login({
    accountId: command.identity.accountId,
    secret: command.identity.secret,
  });
  const session = await facades.auth.authenticateSession(issued.accessToken);
  await facades.lifecycle.createRoom({
    ...session,
    kind: "human",
    requestId: "seed-governance-room",
    idempotencyKey: "seed-governance-room",
  }, { name: "Governance process room" });
}

async function seedRuntimeRoomThroughFacades(
  facades: Parameters<NonNullable<Parameters<typeof startAuthoritativeServerForTest>[1]["initialize"]>>[0],
): Promise<void> {
  const issued = await facades.auth.login({
    accountId: command.identity.accountId,
    secret: command.identity.secret,
  });
  const session = await facades.auth.authenticateSession(issued.accessToken);
  const context = {
    ...session,
    kind: "human" as const,
    requestId: "seed-runtime-room",
    idempotencyKey: "seed-runtime-room",
  };
  const room = await facades.lifecycle.createRoom(context, { name: "Runtime preview sentinel" });
  await facades.lifecycle.configureAgent({
    ...context,
    requestId: "seed-runtime-agent",
    idempotencyKey: "seed-runtime-agent",
  }, {
    kind: "agent-configuration",
    roomId: room.id,
    agentId: "agent-a",
    participation: "active",
    toolPermissions: ["repository.git-status"],
  });
}

function createPreviewSentinelProvider(
  sentinel: string,
  databasePath: string,
): ProviderAdapter {
  const verifyCommittedRecall = (input: AgentRuntimeProviderInput): void => {
    if (!("sourceMessageId" in input.invocation)) {
      throw new Error("Preview sentinel does not accept Project boundary invocations");
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const execution = database.prepare(
        `SELECT status FROM agent_executions
         WHERE trigger_message_id = ? ORDER BY rowid DESC LIMIT 1`,
      ).get(input.invocation.sourceMessageId) as { readonly status: string } | undefined;
      const fence = database.prepare(
        `SELECT COUNT(*) AS count FROM message_recall_fences
         WHERE source_message_id = ? AND scope_kind = 'execution'`,
      ).get(input.invocation.sourceMessageId) as { readonly count: number };
      if (execution?.status !== "cancelled" || fence.count < 1) process.exit(86);
    } finally {
      database.close();
    }
  };
  return Object.freeze({
    id: "preview-sentinel-test-provider",
    async *stream(
      input: AgentRuntimeProviderInput,
      signal: AbortSignal,
    ): AsyncIterable<ProviderEvent> {
      if (!("sourceMessageId" in input.invocation)) {
        throw new Error("Preview sentinel does not accept Project boundary invocations");
      }
      if (input.invocation.sourceMessageId.includes("completed")) {
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "durable completed final", citations: [] };
        return;
      }
      if (input.toolContinuations === undefined) {
        yield { type: "response_started", sequence: 1 };
        yield {
          type: "tool_call_started",
          sequence: 2,
          callId: "preview-sentinel-read",
          toolName: "repository_git_status",
        };
        yield {
          type: "tool_call_delta",
          sequence: 3,
          callId: "preview-sentinel-read",
          delta: "{}",
        };
        yield { type: "completed", sequence: 4 };
        return;
      }
      yield { type: "response_started", sequence: 1 };
      yield { type: "text_delta", sequence: 2, delta: sentinel };
      await new Promise<void>((resolve) => {
        const aborted = (): void => {
          if (signal.reason === "message_recalled") verifyCommittedRecall(input);
          resolve();
        };
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
      });
    },
  });
}

const attachmentFixture = command.enableAttachmentFixture === true
  ? await startAttachmentClamdFixture()
  : undefined;
const offlineReadLeaseKeys = generateKeyPairSync("ed25519");
const attachmentToolPath = resolve(import.meta.dirname, "attachment-tool-child.js");
const serverOptions: StartAuthoritativeServerOptions = {
  databasePath: command.databasePath,
  snapshotCachePath: command.snapshotCachePath,
  sharedAuthority: {
    maxOfflineReadLeaseMs: 60_000,
    offlineReadLeaseSigning: {
      tenantId: "dao-authority-fixture",
      serverSubject: "dao-authority-child",
      keyId: "fixture-key-1",
      privateKey: offlineReadLeaseKeys.privateKey,
    },
  },
  listen: { host: "127.0.0.1", port: 0 },
  actors: command.actors,
  identities,
  invitationSecretKey: Buffer.from(command.invitationSecretKey, "base64url"),
  ...(attachmentFixture === undefined ? {} : {
    attachmentRuntime: {
      storageRoot: join(dirname(command.databasePath), "attachment-store"),
      cwd: dirname(command.databasePath),
      ocrLanguage: "eng",
      capabilityProbeTimeoutMs: 5_000,
      clamd: {
        endpoint: attachmentFixture.endpoint,
        databaseSha256: "a".repeat(64),
        databaseUpdatedAt: new Date().toISOString(),
        policy: PRODUCTION_CLAMD_POLICY,
      },
      pdfinfo: { executable: process.execPath, argvPrefix: [attachmentToolPath, "pdfinfo"] },
      pdftotext: { executable: process.execPath, argvPrefix: [attachmentToolPath, "pdftotext"] },
      pdftoppm: { executable: process.execPath, argvPrefix: [attachmentToolPath, "pdftoppm"] },
      tesseract: { executable: process.execPath, argvPrefix: [attachmentToolPath, "tesseract"] },
    },
  }),
};
const closeCounts = { transport: 0, runtime: 0, snapshots: 0, worker: 0 };
const testOptions = {
  ...(process.platform === "linux" ? {} : { toolAdapterPathFallbackForTest: true as const }),
  ...(command.faultPoint === undefined ? {} : { faultPoint: command.faultPoint }),
  ...(command.forceSnapshotFallback === true ? { snapshotCacheQuotaBytes: 1 } : {}),
  ...(command.snapshotRecordsPerPage === undefined
    ? {}
    : { snapshotMaxRecordsPerPage: command.snapshotRecordsPerPage }),
  ...(command.seedAllFacts === true ? { initialize: seedThroughFacades } : {}),
  ...(command.seedGovernanceRoom === true
    ? { initialize: seedGovernanceRoomThroughFacades }
    : {}),
  ...(command.seedRuntimeRoomForTest === true
    ? { initialize: seedRuntimeRoomThroughFacades }
    : {}),
  ...(command.readbackOnly === true ? { registerMissingActors: false as const } : {}),
  ...(command.previewSentinelForTest === undefined
    ? {}
    : {
        agentRuntimeProviderForTest: createPreviewSentinelProvider(
          command.previewSentinelForTest,
          command.databasePath,
        ),
      }),
  ...(command.closeCleanupProbe === true ? {
    afterCloseForTest: {
      transport() {
        closeCounts.transport += 1;
        throw new Error("transport close probe");
      },
      runtime() { closeCounts.runtime += 1; },
      snapshots() { closeCounts.snapshots += 1; },
      worker() { closeCounts.worker += 1; },
    },
  } : {}),
};
const server = Object.keys(testOptions).length > 0
  ? await startAuthoritativeServerForTest(serverOptions, testOptions)
  : await startAuthoritativeServer(serverOptions);

if (command.closeCleanupProbe === true) {
  const first = server.close();
  const samePromise = server.close() === first;
  const failure = await first.catch((error: unknown) => error);
  const reopened = process.platform === "linux"
    ? await startAuthoritativeServer(serverOptions)
    : await startAuthoritativeServerForTest(serverOptions, {
        toolAdapterPathFallbackForTest: true,
      });
  await reopened.close();
  await attachmentFixture?.close();
  process.stdout.write(`${JSON.stringify({
    type: "close-cleanup-probed",
    samePromise,
    aggregate: failure instanceof AggregateError,
    closeCounts,
  })}\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify({ type: "ready", url: server.url })}\n`);
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    await attachmentFixture?.close();
  }
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
