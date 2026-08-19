import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { deriveLegacyPublicSessionId } from "../auth.js";
import {
  createWorkerDatabaseClient,
  type WorkerDatabaseClient,
} from "./worker-database-client.js";
import {
  importLegacyStateForTest,
  type LegacyImportPaths,
} from "./legacy-importer.js";
import {
  isAuthorityWorkerRequest,
  isAuthorityWorkerResponse,
} from "./worker-protocol.js";

const temporaryDirectories = new Set<string>();
const clients = new Set<WorkerDatabaseClient>();
const WORKER_INITIALIZATION_TEST_TIMEOUT_MS = 15_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "native-im-legacy-import-"));
  temporaryDirectories.add(directory);
  return directory;
}

function writeLegacyFixture(
  directory: string,
  sessionMetadata: Readonly<Record<string, unknown>> = {},
): {
  readonly sessionFilePath: string;
  readonly roomFilePath: string;
  readonly messageFilePath: string;
  readonly originalBytes: ReadonlyMap<string, Buffer>;
} {
  const sessionFilePath = join(directory, "sessions.json");
  const roomFilePath = join(directory, "rooms.json");
  const messageFilePath = join(directory, "messages.jsonl");
  const createdAt = "2026-08-09T08:00:00.000Z";

  writeFileSync(
    sessionFilePath,
    JSON.stringify({
      version: 1,
      sessions: [
        {
          familyId: hash("family-owner"),
          accountId: "account-owner",
          actorId: "human-owner",
          accessTokenHash: hash("access-owner"),
          refreshTokenHash: hash("refresh-owner"),
          accessExpiresAt: 1_800_000_000_000,
          refreshExpiresAt: 1_900_000_000_000,
          ...sessionMetadata,
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    roomFilePath,
    JSON.stringify({
      version: 1,
      actors: [
        {
          id: "human-owner",
          kind: "human",
          displayName: "Owner",
          reachability: "online",
        },
        {
          id: "human-observer",
          kind: "human",
          displayName: "Observer",
          reachability: "offline",
        },
        {
          id: "agent-helper",
          kind: "agent",
          displayName: "Helper",
          readiness: "ready",
          toolPermissions: ["search"],
        },
      ],
      rooms: [
        {
          id: "room-main",
          name: "Main",
          status: "active",
          members: [
            {
              kind: "human",
              actorId: "human-owner",
              role: "owner",
              joinedAt: createdAt,
            },
            {
              kind: "agent",
              actorId: "agent-helper",
              participation: "active",
              toolPermissions: ["search"],
              configuredAt: "2026-08-09T08:00:30.000Z",
            },
          ],
          createdAt,
        },
      ],
      invitations: [
        {
          id: "invitation-observer",
          roomId: "room-main",
          inviterActorId: "human-owner",
          inviteeActorId: "human-observer",
          tokenHash: hash("observer-invitation"),
          status: "pending",
          createdAt: "2026-08-09T08:00:40.000Z",
        },
      ],
      audit: [
        {
          id: "audit-room-created",
          type: "room.created",
          roomId: "room-main",
          actorId: "human-owner",
          result: "created",
          timestamp: createdAt,
        },
        {
          id: "audit-agent-configured",
          type: "room.agent.configured",
          roomId: "room-main",
          actorId: "human-owner",
          targetActorId: "agent-helper",
          participation: "active",
          toolPermissions: ["search"],
          result: "configured",
          timestamp: "2026-08-09T08:00:30.000Z",
        },
        {
          id: "audit-observer-invited",
          type: "room.human.invited",
          roomId: "room-main",
          actorId: "human-owner",
          targetActorId: "human-observer",
          invitationId: "invitation-observer",
          result: "pending",
          timestamp: "2026-08-09T08:00:40.000Z",
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    messageFilePath,
    [
      JSON.stringify({
        id: "message-human",
        roomId: "room-main",
        authorId: "human-owner",
        authorKind: "human",
        body: "hello",
        sentAt: "2026-08-09T08:01:00.000Z",
      }),
      JSON.stringify({
        id: "message-agent",
        roomId: "room-main",
        authorId: "agent-helper",
        authorKind: "agent",
        body: "ready",
        sentAt: "2026-08-09T08:02:00.000Z",
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    sessionFilePath,
    roomFilePath,
    messageFilePath,
    originalBytes: new Map(
      [sessionFilePath, roomFilePath, messageFilePath].map((path) => [
        path,
        readFileSync(path),
      ]),
    ),
  };
}

function importPaths(
  fixture: ReturnType<typeof writeLegacyFixture>,
): LegacyImportPaths {
  return {
    sessionFilePath: fixture.sessionFilePath,
    roomFilePath: fixture.roomFilePath,
    messageFilePath: fixture.messageFilePath,
  };
}

function expectNoStagingFiles(directory: string): void {
  expect(
    readdirSync(directory).filter(
      (entry) => entry.includes("legacy-import") || entry.endsWith("-wal") || entry.endsWith("-shm"),
    ),
  ).toEqual([]);
}

async function expectImportRejectedWithoutActivation(
  mutate: (fixture: ReturnType<typeof writeLegacyFixture>) => void,
): Promise<void> {
  const directory = fixtureDirectory();
  const databasePath = join(directory, "authority.sqlite");
  const fixture = writeLegacyFixture(directory);
  mutate(fixture);
  const client = track(await createWorkerDatabaseClient({ databasePath }));

  const error = await client.importLegacyState(importPaths(fixture)).then(
    () => new Error("expected import rejection"),
    (reason: unknown) => reason,
  );

  expect(error).toMatchObject({
    code: "legacy_import_failed",
    message: "Legacy authority import failed",
  });
  expect(String(error)).not.toContain(directory);
  expect(existsSync(databasePath)).toBe(false);
  expectNoStagingFiles(directory);
}

function track(client: WorkerDatabaseClient): WorkerDatabaseClient {
  clients.add(client);
  return client;
}

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close().catch(() => undefined)));
  clients.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("LegacyStateImporter", () => {
  it("imports explicit T-0039 files once and restarts from the SQLite marker", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    const client = track(await createWorkerDatabaseClient({ databasePath }));

    const result = await client.importLegacyState(importPaths(fixture));

    expect(result).toEqual({ imported: true, actors: 3, rooms: 1, messages: 2 });
    expect(existsSync(databasePath)).toBe(true);
    for (const [path, bytes] of fixture.originalBytes) {
      expect(readFileSync(path)).toEqual(bytes);
    }

    await expect(
      client.importLegacyState({
        sessionFilePath: join(directory, "deleted-sessions.json"),
        roomFilePath: join(directory, "deleted-rooms.json"),
        messageFilePath: join(directory, "deleted-messages.jsonl"),
      }),
    ).resolves.toEqual({ imported: false, actors: 3, rooms: 1, messages: 2 });

    await client.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memberships").get())
        .toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_invitations").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_audit").get())
        .toEqual({ count: 3 });
      const importedFamilies = database.prepare(
        `SELECT public_id AS publicId, device_id AS deviceId,
                device_label AS deviceLabel, platform, created_at AS createdAt,
                refresh_expires_at AS refreshExpiresAt, revoked_at AS revokedAt
         FROM session_families`,
      ).all();
      expect(importedFamilies).toEqual([{
        publicId: deriveLegacyPublicSessionId(hash("family-owner")),
        deviceId: "legacy",
        deviceLabel: "Legacy device",
        platform: "unknown",
        createdAt: null,
        refreshExpiresAt: 1_900_000_000_000,
        revokedAt: null,
      }]);
      expect(String(importedFamilies[0]?.publicId)).not.toContain(hash("family-owner"));
      expect(database.prepare("SELECT DISTINCT catalog_revision FROM actors").all())
        .toEqual([{ catalog_revision: 0 }]);
      expect(
        database.prepare("SELECT DISTINCT access_revision FROM room_memberships").all(),
      ).toEqual([{ access_revision: 0 }]);
      expect(
        database
          .prepare(
            `SELECT stream_kind, COUNT(*) AS count, MIN(head_seq) AS minimum_head,
                    MAX(head_seq) AS maximum_head,
                    MIN(retained_from_seq) AS minimum_retained,
                    MAX(retained_from_seq) AS maximum_retained
             FROM streams GROUP BY stream_kind ORDER BY stream_kind`,
          )
          .all(),
      ).toEqual([
        {
          stream_kind: "identity",
          count: 3,
          minimum_head: 0,
          maximum_head: 0,
          minimum_retained: 1,
          maximum_retained: 1,
        },
        {
          stream_kind: "room",
          count: 1,
          minimum_head: 0,
          maximum_head: 0,
          minimum_retained: 1,
          maximum_retained: 1,
        },
      ]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
        count: 0,
      });
      expect(
        database.prepare(
          `SELECT envelope.message_id AS messageId,
                  envelope.message_kind AS messageKind,
                  envelope.lifecycle,
                  envelope.current_revision AS currentRevision,
                  envelope.revision_count AS revisionCount,
                  revision.body,
                  revision.revised_at AS revisedAt,
                  revision.revised_by_actor_id AS revisedByActorId
           FROM message_envelopes AS envelope
           JOIN message_revisions AS revision
             ON revision.message_id = envelope.message_id
            AND revision.revision = 1
           ORDER BY envelope.message_id`,
        ).all(),
      ).toEqual([
        {
          messageId: "message-agent",
          messageKind: "agent-final",
          lifecycle: "active",
          currentRevision: 1,
          revisionCount: 1,
          body: "ready",
          revisedAt: "2026-08-09T08:02:00.000Z",
          revisedByActorId: "agent-helper",
        },
        {
          messageId: "message-human",
          messageKind: "human",
          lifecycle: "active",
          currentRevision: 1,
          revisionCount: 1,
          body: "hello",
          revisedAt: "2026-08-09T08:01:00.000Z",
          revisedByActorId: "human-owner",
        },
      ]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM message_target_outcomes").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
    const restarted = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(restarted.inspectLegacyImport()).resolves.toMatchObject({
      markerVersion: 1,
      actors: 3,
      rooms: 1,
      messages: 2,
      roomHeadSeq: 0,
      identityHeadSeq: 0,
    });
    await expect(
      restarted.importLegacyState({
        sessionFilePath: join(directory, "missing-a"),
        roomFilePath: join(directory, "missing-b"),
        messageFilePath: join(directory, "missing-c"),
      }),
    ).resolves.toEqual({ imported: false, actors: 3, rooms: 1, messages: 2 });
  });

  it("preserves complete current-format session family metadata during import", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory, {
      publicSessionId: "public-desktop-session",
      deviceId: "desktop-installation-01",
      deviceLabel: "Leo's MacBook",
      platform: "macos",
      createdAt: 1_700_000_000_123,
    });
    const client = track(await createWorkerDatabaseClient({ databasePath }));

    await expect(client.importLegacyState(importPaths(fixture))).resolves.toMatchObject({
      imported: true,
    });
    await client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        `SELECT public_id AS publicId, device_id AS deviceId,
                device_label AS deviceLabel, platform, created_at AS createdAt
         FROM session_families`,
      ).all()).toEqual([{
        publicId: "public-desktop-session",
        deviceId: "desktop-installation-01",
        deviceLabel: "Leo's MacBook",
        platform: "macos",
        createdAt: 1_700_000_000_123,
      }]);
    } finally {
      database.close();
    }
  });

  it("rejects an over-cap active legacy principal before staging activation", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    const sessionState = JSON.parse(
      readFileSync(fixture.sessionFilePath, "utf8"),
    ) as { sessions: Array<Record<string, unknown>> };
    const template = sessionState.sessions[0];
    if (template === undefined) throw new Error("legacy session fixture is missing");
    const futureExpiry = Date.now() + 24 * 60 * 60 * 1_000;
    sessionState.sessions = Array.from({ length: 97 }, (_, index) => ({
      ...template,
      familyId: hash(`capacity-family-${index}`),
      accessTokenHash: hash(`capacity-access-${index}`),
      refreshTokenHash: hash(`capacity-refresh-${index}`),
      accessExpiresAt: futureExpiry - 1_000,
      refreshExpiresAt: futureExpiry,
    }));
    writeFileSync(fixture.sessionFilePath, JSON.stringify({
      version: 1,
      sessions: sessionState.sessions,
    }), "utf8");

    await expect(importLegacyStateForTest(
      { databasePath, ...importPaths(fixture) },
      {},
    )).rejects.toThrow(/legacy active session family capacity exceeds 96/i);
    expect(existsSync(databasePath)).toBe(false);
    expectNoStagingFiles(directory);
  });

  it("replays the original marker result after valid authority state evolves", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    const importer = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(importer.importLegacyState(importPaths(fixture))).resolves.toEqual({
      imported: true,
      actors: 3,
      rooms: 1,
      messages: 2,
    });
    await importer.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      database
        .prepare(
          `INSERT INTO actors (
             id, kind, display_name, reachability, readiness,
             tool_permissions_json, catalog_revision
           ) VALUES (?, 'human', ?, 'offline', NULL, '[]', 0)`,
        )
        .run("human-after-import", "Later Human");
      database
        .prepare(
          `INSERT INTO streams (
             stream_kind, stream_id, head_seq, retained_from_seq
           ) VALUES ('identity', ?, 0, 1)`,
        )
        .run("human-after-import");
      database.exec("COMMIT");
    } finally {
      database.close();
    }

    const restarted = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(restarted.inspectLegacyImport()).rejects.toMatchObject({
      code: "legacy_import_unavailable",
    });
    await expect(
      restarted.importLegacyState({
        sessionFilePath: join(directory, "missing-a"),
        roomFilePath: join(directory, "different-b"),
        messageFilePath: join(directory, "missing-c"),
      }),
    ).resolves.toEqual({ imported: false, actors: 3, rooms: 1, messages: 2 });
  });

  it("fails closed when an existing authority import marker is malformed", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    const importer = track(await createWorkerDatabaseClient({ databasePath }));
    await importer.importLegacyState(importPaths(fixture));
    await importer.close();

    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(
          `UPDATE idempotency_records SET response_json = ?
           WHERE scope = ? AND key = ?`,
        )
        .run(
          JSON.stringify({ markerVersion: 1, actors: 3, rooms: 1, messages: 2 }),
          "__authority_legacy_import__",
          "t0039-v1",
        );
    } finally {
      database.close();
    }

    const restarted = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(
      restarted.importLegacyState({
        sessionFilePath: join(directory, "missing-a"),
        roomFilePath: join(directory, "missing-b"),
        messageFilePath: join(directory, "missing-c"),
      }),
    ).rejects.toMatchObject({
      code: "legacy_import_failed",
      message: "Legacy authority import failed",
    });
  });

  it("rejects corrupt cross-file references, actor kinds, JSONL, and global IDs", async () => {
    await expectImportRejectedWithoutActivation((fixture) => {
      const sessions = JSON.parse(readFileSync(fixture.sessionFilePath, "utf8"));
      sessions.sessions[0].actorId = "missing-human";
      writeFileSync(fixture.sessionFilePath, JSON.stringify(sessions), "utf8");
    });
    await expectImportRejectedWithoutActivation((fixture) => {
      const messages = readFileSync(fixture.messageFilePath, "utf8").split("\n");
      const message = JSON.parse(messages[0]!);
      message.authorKind = "agent";
      messages[0] = JSON.stringify(message);
      writeFileSync(fixture.messageFilePath, messages.join("\n"), "utf8");
    });
    await expectImportRejectedWithoutActivation((fixture) => {
      writeFileSync(fixture.messageFilePath, "{not-json}\n", "utf8");
    });
    await expectImportRejectedWithoutActivation((fixture) => {
      const messages = readFileSync(fixture.messageFilePath, "utf8").split("\n");
      const message = JSON.parse(messages[0]!);
      message.id = "human-owner";
      messages[0] = JSON.stringify(message);
      writeFileSync(fixture.messageFilePath, messages.join("\n"), "utf8");
    });
  });

  it("rejects extra fields in every legacy input", async () => {
    await expectImportRejectedWithoutActivation((fixture) => {
      const sessions = JSON.parse(readFileSync(fixture.sessionFilePath, "utf8"));
      sessions.extra = true;
      writeFileSync(fixture.sessionFilePath, JSON.stringify(sessions), "utf8");
    });
    await expectImportRejectedWithoutActivation((fixture) => {
      const rooms = JSON.parse(readFileSync(fixture.roomFilePath, "utf8"));
      rooms.actors[0].extra = true;
      writeFileSync(fixture.roomFilePath, JSON.stringify(rooms), "utf8");
    });
    await expectImportRejectedWithoutActivation((fixture) => {
      const lines = readFileSync(fixture.messageFilePath, "utf8").split("\n");
      const message = JSON.parse(lines[0]!);
      message.extra = true;
      lines[0] = JSON.stringify(message);
      writeFileSync(fixture.messageFilePath, lines.join("\n"), "utf8");
    });
  });

  it("cleans staging files when the test seam faults before activation", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);

    await expect(
      importLegacyStateForTest(
        { databasePath, ...importPaths(fixture) },
        {
          beforeActivate() {
            throw new Error("fault-before-activate");
          },
        },
      ),
    ).rejects.toThrow("fault-before-activate");

    expect(existsSync(databasePath)).toBe(false);
    expectNoStagingFiles(directory);
  });

  it("reconciles a pre-link crash while keeping the final path absent", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);

    await expect(
      importLegacyStateForTest(
        { databasePath, ...importPaths(fixture) },
        {
          afterManifestDurable() {
            throw new Error("simulated pre-link crash");
          },
        },
      ),
    ).rejects.toThrow("simulated pre-link crash");

    const stagingFileName = readdirSync(directory).find((entry) =>
      entry.endsWith(".legacy-import.sqlite"),
    );
    const recoveryFileName = readdirSync(directory).find((entry) =>
      entry.endsWith(".legacy-import.recovery.json"),
    );
    expect(stagingFileName).toBeTypeOf("string");
    expect(recoveryFileName).toBeTypeOf("string");
    expect(existsSync(databasePath)).toBe(false);
    expect(lstatSync(join(directory, stagingFileName!), { bigint: true }).nlink).toBe(
      1n,
    );

    const restarted = track(await createWorkerDatabaseClient({ databasePath }));
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(directory, stagingFileName!))).toBe(false);
    expect(existsSync(join(directory, recoveryFileName!))).toBe(false);
    for (const [path, bytes] of fixture.originalBytes) {
      expect(readFileSync(path)).toEqual(bytes);
    }
    await expect(restarted.close()).resolves.toBeUndefined();
  });

  it("fails closed for a missing-final recovery candidate without an import marker", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const nonce = "00000000-0000-4000-8000-000000000041";
    const recoveryBase = `.authority.sqlite.${nonce}.legacy-import`;
    const stagingFileName = `${recoveryBase}.sqlite`;
    const stagingPath = join(directory, stagingFileName);
    const recoveryPath = join(directory, `${recoveryBase}.recovery.json`);

    const creator = track(
      await createWorkerDatabaseClient({ databasePath: stagingPath }),
    );
    await expect(creator.inspectSchema()).resolves.toEqual({ version: 18 });
    await creator.close();
    writeFileSync(
      recoveryPath,
      JSON.stringify({
        version: 1,
        databaseFileName: "authority.sqlite",
        stagingFileName,
        nonce,
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const stagingBytes = readFileSync(stagingPath);
    const manifestBytes = readFileSync(recoveryPath);

    await expect(createWorkerDatabaseClient({ databasePath })).rejects.toMatchObject({
      code: "storage_unavailable",
      message: "Authority database initialization failed",
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(readFileSync(stagingPath)).toEqual(stagingBytes);
    expect(readFileSync(recoveryPath)).toEqual(manifestBytes);
  }, WORKER_INITIALIZATION_TEST_TIMEOUT_MS);

  it("fails closed for ambiguous missing-final recovery manifests", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    await expect(
      importLegacyStateForTest(
        { databasePath, ...importPaths(fixture) },
        {
          afterManifestDurable() {
            throw new Error("simulated pre-link crash");
          },
        },
      ),
    ).rejects.toThrow("simulated pre-link crash");

    const stagingFileName = readdirSync(directory).find((entry) =>
      entry.endsWith(".legacy-import.sqlite"),
    );
    const firstRecoveryFileName = readdirSync(directory).find((entry) =>
      entry.endsWith(".legacy-import.recovery.json"),
    );
    expect(stagingFileName).toBeTypeOf("string");
    expect(firstRecoveryFileName).toBeTypeOf("string");
    const secondNonce = "00000000-0000-4000-8000-000000000042";
    const secondRecoveryPath = join(
      directory,
      `.authority.sqlite.${secondNonce}.legacy-import.recovery.json`,
    );
    writeFileSync(
      secondRecoveryPath,
      JSON.stringify({
        version: 1,
        databaseFileName: "authority.sqlite",
        stagingFileName: `.authority.sqlite.${secondNonce}.legacy-import.sqlite`,
        nonce: secondNonce,
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    await expect(createWorkerDatabaseClient({ databasePath })).rejects.toMatchObject({
      code: "storage_unavailable",
      message: "Authority database path could not be resolved",
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(directory, stagingFileName!))).toBe(true);
    expect(existsSync(join(directory, firstRecoveryFileName!))).toBe(true);
    expect(existsSync(secondRecoveryPath)).toBe(true);
  });

  it("reconciles a post-unlink manifest without changing the final database", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);

    await expect(
      importLegacyStateForTest(
        { databasePath, ...importPaths(fixture) },
        {
          afterStagingUnlink() {
            throw new Error("simulated post-unlink crash");
          },
        },
      ),
    ).rejects.toThrow("simulated post-unlink crash");

    const before = readFileSync(databasePath);
    const recoveryFileName = readdirSync(directory).find((entry) =>
      entry.endsWith(".legacy-import.recovery.json"),
    );
    expect(recoveryFileName).toBeTypeOf("string");
    expect(
      readdirSync(directory).some((entry) => entry.endsWith(".legacy-import.sqlite")),
    ).toBe(false);
    expect(lstatSync(databasePath, { bigint: true }).nlink).toBe(1n);

    const restarted = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(restarted.inspectSchema()).resolves.toEqual({ version: 18 });
    await expect(restarted.inspectLegacyImport()).resolves.toMatchObject({
      markerVersion: 1,
      actors: 3,
      rooms: 1,
      messages: 2,
    });
    await restarted.close();
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(join(directory, recoveryFileName!))).toBe(false);
    for (const [path, bytes] of fixture.originalBytes) {
      expect(readFileSync(path)).toEqual(bytes);
    }
  }, WORKER_INITIALIZATION_TEST_TIMEOUT_MS);

  it("never clobbers a database that wins the activation race", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    const winner = Buffer.from("concurrent-authority-winner");

    await expect(
      importLegacyStateForTest(
        { databasePath, ...importPaths(fixture) },
        {
          beforeActivate() {
            writeFileSync(databasePath, winner);
          },
        },
      ),
    ).rejects.toThrow();

    expect(readFileSync(databasePath)).toEqual(winner);
    expectNoStagingFiles(directory);
  });

  it("recovers an importer-owned crash remainder after final link activation", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    await expect(
      importLegacyStateForTest(
        { databasePath, ...importPaths(fixture) },
        {
          afterActivateLink() {
            throw new Error("simulated activation crash");
          },
        },
      ),
    ).rejects.toThrow("simulated activation crash");

    const stagingFileName = readdirSync(directory).find((entry) =>
      entry.endsWith(".legacy-import.sqlite"),
    );
    const recoveryFileName = readdirSync(directory).find((entry) =>
      entry.endsWith(".legacy-import.recovery.json"),
    );
    expect(stagingFileName).toBeTypeOf("string");
    expect(recoveryFileName).toBeTypeOf("string");
    const stagingPath = join(directory, stagingFileName!);
    const recoveryPath = join(directory, recoveryFileName!);
    expect(existsSync(databasePath)).toBe(true);
    const finalMetadata = lstatSync(databasePath, { bigint: true });
    const stagingMetadata = lstatSync(stagingPath, { bigint: true });
    expect(stagingMetadata.dev).toBe(finalMetadata.dev);
    expect(stagingMetadata.ino).toBe(finalMetadata.ino);
    expect(finalMetadata.nlink).toBe(2n);
    for (const [path, bytes] of fixture.originalBytes) {
      expect(readFileSync(path)).toEqual(bytes);
    }

    const unrelatedHardlinkPath = join(directory, "unrelated-authority-hardlink.sqlite");
    linkSync(databasePath, unrelatedHardlinkPath);
    await expect(createWorkerDatabaseClient({ databasePath })).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(existsSync(stagingPath)).toBe(true);
    expect(existsSync(recoveryPath)).toBe(true);
    expect(existsSync(unrelatedHardlinkPath)).toBe(true);
    rmSync(unrelatedHardlinkPath);

    const restarted = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(restarted.inspectSchema()).resolves.toEqual({ version: 18 });
    await expect(restarted.inspectLegacyImport()).resolves.toMatchObject({
      markerVersion: 1,
      actors: 3,
      rooms: 1,
      messages: 2,
    });
    expect(existsSync(stagingPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
    expect(lstatSync(databasePath, { bigint: true }).nlink).toBe(1n);
  });

  it("does not recover a controlled-looking hardlink without an import marker", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const creator = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(creator.inspectSchema()).resolves.toEqual({ version: 18 });
    await creator.close();
    const before = readFileSync(databasePath);
    const nonce = "00000000-0000-4000-8000-000000000040";
    const recoveryBase = `.authority.sqlite.${nonce}.legacy-import`;
    const stagingFileName = `${recoveryBase}.sqlite`;
    const stagingPath = join(directory, stagingFileName);
    const recoveryPath = join(directory, `${recoveryBase}.recovery.json`);
    linkSync(databasePath, stagingPath);
    writeFileSync(
      recoveryPath,
      JSON.stringify({
        version: 1,
        databaseFileName: "authority.sqlite",
        stagingFileName,
        nonce,
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    await expect(createWorkerDatabaseClient({ databasePath })).rejects.toMatchObject({
      code: "storage_unavailable",
      message: "Authority database initialization failed",
    });
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(stagingPath)).toBe(true);
    expect(existsSync(recoveryPath)).toBe(true);
  }, WORKER_INITIALIZATION_TEST_TIMEOUT_MS);

  it("does not overwrite an existing valid authority database without a marker", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const fixture = writeLegacyFixture(directory);
    const creator = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(creator.inspectSchema()).resolves.toEqual({ version: 18 });
    await creator.close();
    const before = readFileSync(databasePath);

    const importer = track(await createWorkerDatabaseClient({ databasePath }));
    await expect(importer.importLegacyState(importPaths(fixture))).rejects.toMatchObject({
      code: "legacy_import_failed",
      message: "Legacy authority import failed",
    });
    await importer.close();

    expect(readFileSync(databasePath)).toEqual(before);
  }, WORKER_INITIALIZATION_TEST_TIMEOUT_MS);

  it("closes successfully without opening or creating the authority database", async () => {
    const directory = fixtureDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const client = track(await createWorkerDatabaseClient({ databasePath }));

    await expect(client.close()).resolves.toBeUndefined();
    expect(existsSync(databasePath)).toBe(false);
  });

  it("keeps the import protocol closed around three explicit paths", () => {
    expect(
      isAuthorityWorkerRequest({
        type: "authority.import-legacy",
        requestId: "1",
        sessionFilePath: "/sessions.json",
        roomFilePath: "/rooms.json",
        messageFilePath: "/messages.jsonl",
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.import-legacy",
        requestId: "2",
        directoryPath: "/legacy",
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.import-legacy",
        requestId: "3",
        sessionFilePath: "/sessions.json",
        roomFilePath: "/rooms.json",
        messageFilePath: "/messages.jsonl",
        faultBeforeActivate: true,
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.legacy-imported",
        requestId: "4",
        imported: true,
        actors: 3,
        rooms: 1,
        messages: 2,
        extra: true,
      }),
    ).toBe(false);
  });
});
