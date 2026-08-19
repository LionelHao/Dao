import type {
  ActiveHumanMessage,
  AgentFinalMessage,
  MessageAuthorityEvent,
  MessageAuthorityRepairRecord,
  MessageTombstone,
} from "@native-im/core";
import { describe, expect, it } from "vitest";

import {
  MessageAuthorityReplicaError,
  advanceMessageAuthorityCursor,
  applyMessageAuthorityEvent,
  beginMessageAuthorityRepair,
  commitMessageAuthorityRepair,
  createMessageAuthorityReplica,
  failMessageAuthorityRepair,
  markMessageAuthorityOfflineReadOnly,
  revokeMessageAuthorityRoom,
  stageMessageAuthorityRepairRecord,
} from "./message-authority-replica.js";

const createdAt = "2026-08-19T08:00:00.000Z";

function human(revision = 1, body = "Human body"): ActiveHumanMessage {
  return {
    id: "message-human",
    roomId: "room-1",
    authorId: "human-1",
    authorKind: "human",
    createdAt,
    lifecycle: "active",
    currentRevision: {
      messageId: "message-human",
      revision,
      body,
      revisedAt: `2026-08-19T08:0${revision - 1}:00.000Z`,
      revisedByActorId: "human-1",
    },
    revisionCount: revision,
    mentionedTargets: [{
      id: "target-agent",
      kind: "agent-invocation",
      targetActorId: "agent-1",
      range: { startUtf16: 0, endUtf16: 5 },
    }],
    replyToMessageId: "message-parent",
    attachments: [{ attachmentId: "attachment-1" }],
    targetOutcomes: [{
      targetId: "target-agent",
      targetActorId: "agent-1",
      kind: "agent-invocation",
      status: "invocation-intent-created",
      invocationIntentId: "intent-1",
    }],
  };
}

function tombstone(revisionCount = 2): MessageTombstone {
  return {
    id: "message-human",
    roomId: "room-1",
    authorId: "human-1",
    authorKind: "human",
    createdAt,
    lifecycle: "recalled",
    recalledAt: "2026-08-19T08:03:00.000Z",
    revisionCount,
  };
}

function agent(id = "message-agent", correctsMessageId?: string): AgentFinalMessage {
  return {
    id,
    roomId: "room-1",
    authorId: "agent-1",
    authorKind: "agent",
    createdAt: "2026-08-19T08:04:00.000Z",
    lifecycle: "active",
    finalBody: correctsMessageId === undefined ? "Final" : "Correction",
    sourceInvocationIntentId: "intent-1",
    sourceExecutionId: correctsMessageId === undefined ? "execution-1" : "execution-2",
    ...(correctsMessageId === undefined ? {} : { correctsMessageId }),
  };
}

function event(
  streamSeq: number,
  type: MessageAuthorityEvent["type"],
  payload: MessageAuthorityEvent["payload"],
  eventId = `event-${streamSeq}`,
): MessageAuthorityEvent {
  return {
    eventId,
    streamKind: "room",
    streamId: "room-1",
    streamSeq,
    roomId: "room-1",
    type,
    actorId: payload.authorId,
    occurredAt: payload.lifecycle === "recalled"
      ? payload.recalledAt
      : payload.authorKind === "human"
        ? payload.currentRevision.revisedAt
        : payload.createdAt,
    payload,
  } as MessageAuthorityEvent;
}

function record(value: ActiveHumanMessage | AgentFinalMessage | MessageTombstone): MessageAuthorityRepairRecord {
  return { kind: "timeline-message", value };
}

describe("Desktop message authority operational replica", () => {
  it("applies accepted, monotonically revised, and recalled events without moving timeline identity", () => {
    let replica = createMessageAuthorityReplica("room-1");
    replica = applyMessageAuthorityEvent(
      replica,
      event(1, "room.message.accepted", human(1, "RECALLED-RAW-SENTINEL")),
    );
    replica = applyMessageAuthorityEvent(
      replica,
      event(2, "room.message.revised", human(2, "RECALLED-RAW-SENTINEL revised")),
    );

    expect(replica.timeline).toHaveLength(1);
    expect((replica.timeline[0] as ActiveHumanMessage).currentRevision.revision).toBe(2);
    expect(replica.afterSeq).toBe(2);

    replica = applyMessageAuthorityEvent(
      replica,
      event(3, "room.message.recalled", tombstone()),
    );
    expect(replica.timeline).toEqual([tombstone()]);
    expect(JSON.stringify(replica)).not.toContain("RECALLED-RAW-SENTINEL");
    expect(JSON.stringify(replica)).not.toContain("mentionedTargets");
    expect(JSON.stringify(replica)).not.toContain("attachments");
  });

  it("deduplicates exact eventId replays and fails closed on event/sequence conflicts or gaps", () => {
    const accepted = event(1, "room.message.accepted", human());
    const replica = applyMessageAuthorityEvent(
      createMessageAuthorityReplica("room-1"),
      accepted,
    );

    expect(applyMessageAuthorityEvent(replica, accepted)).toBe(replica);
    expect(() => applyMessageAuthorityEvent(
      replica,
      event(2, "room.message.revised", human(2), "event-1"),
    )).toThrow(new MessageAuthorityReplicaError("event_conflict"));
    expect(() => applyMessageAuthorityEvent(
      replica,
      event(1, "room.message.accepted", agent(), "event-other"),
    )).toThrow(new MessageAuthorityReplicaError("event_conflict"));
    expect(() => applyMessageAuthorityEvent(
      replica,
      event(3, "room.message.revised", human(2)),
    )).toThrow(new MessageAuthorityReplicaError("event_gap"));
  });

  it("advances across non-message Room events without inventing a message sequence", () => {
    let replica = createMessageAuthorityReplica("room-1");
    replica = advanceMessageAuthorityCursor(replica, {
      eventId: "room-renamed-1",
      streamSeq: 1,
    });
    expect(replica).toMatchObject({
      afterSeq: 1,
      timeline: [],
      eventLedger: [{ eventId: "room-renamed-1", streamSeq: 1 }],
    });

    replica = applyMessageAuthorityEvent(
      replica,
      event(2, "room.message.accepted", human(), "message-event-2"),
    );
    expect(replica.afterSeq).toBe(2);
    expect(replica.timeline).toEqual([human()]);
    expect(() => advanceMessageAuthorityCursor(replica, {
      eventId: "wrong-attempt",
      streamSeq: 4,
    })).toThrow(new MessageAuthorityReplicaError("event_gap"));
  });

  it("rejects revision regression and changes to frozen targets, reply, attachments, or outcomes", () => {
    let replica = createMessageAuthorityReplica("room-1");
    replica = applyMessageAuthorityEvent(replica, event(1, "room.message.accepted", human()));
    replica = applyMessageAuthorityEvent(replica, event(2, "room.message.revised", human(2)));

    expect(() => applyMessageAuthorityEvent(
      replica,
      event(3, "room.message.revised", human(1)),
    )).toThrow(new MessageAuthorityReplicaError("revision_regression"));

    const changed = human(3, "Human body revised again");
    const structurallyChanged: ActiveHumanMessage = {
      ...changed,
      replyToMessageId: "different-parent",
    };
    expect(() => applyMessageAuthorityEvent(
      replica,
      event(3, "room.message.revised", structurallyChanged),
    )).toThrow(new MessageAuthorityReplicaError("immutable_source_changed"));
    expect((replica.timeline[0] as ActiveHumanMessage).currentRevision.revision).toBe(2);
  });

  it("keeps Agent final and correction as separate immutable source-lineage entries", () => {
    let replica = createMessageAuthorityReplica("room-1");
    replica = applyMessageAuthorityEvent(
      replica,
      event(1, "room.message.accepted", agent()),
    );
    replica = applyMessageAuthorityEvent(
      replica,
      event(2, "room.message.accepted", agent("message-correction", "message-agent")),
    );
    expect(replica.timeline.map(({ id }) => id)).toEqual([
      "message-agent",
      "message-correction",
    ]);
    expect((replica.timeline[0] as AgentFinalMessage).finalBody).toBe("Final");

    expect(() => applyMessageAuthorityEvent(
      replica,
      event(3, "room.message.accepted", { ...agent(), finalBody: "Overwrite" }),
    )).toThrow(new MessageAuthorityReplicaError("immutable_message_conflict"));
  });

  it("stages repair invisibly and flips timeline, generation, checkpoint, and ledger atomically", () => {
    let replica = createMessageAuthorityReplica("room-1");
    replica = applyMessageAuthorityEvent(
      replica,
      event(1, "room.message.accepted", human(1, "old complete")),
    );
    replica = beginMessageAuthorityRepair(replica, {
      snapshotId: "snapshot-1",
      watermark: 10,
      generation: 2,
    });
    replica = stageMessageAuthorityRepairRecord(
      replica,
      "snapshot-1",
      record(human(3, "new complete")),
    );

    expect((replica.timeline[0] as ActiveHumanMessage).currentRevision.body).toBe("old complete");
    expect(replica.generation).toBe(1);
    expect(replica.mode).toBe("repairing");

    replica = commitMessageAuthorityRepair(replica, {
      snapshotId: "snapshot-1",
      watermark: 10,
      generation: 2,
    });
    expect((replica.timeline[0] as ActiveHumanMessage).currentRevision.body).toBe("new complete");
    expect(replica).toMatchObject({
      mode: "online",
      generation: 2,
      checkpoint: 10,
      afterSeq: 10,
      eventLedger: [],
    });

    const stale = event(9, "room.message.revised", human(2));
    expect(applyMessageAuthorityEvent(replica, stale)).toBe(replica);
  });

  it("retains the old complete generation on repair failure or locks and purges on revoke", () => {
    let old = createMessageAuthorityReplica("room-1");
    old = applyMessageAuthorityEvent(
      old,
      event(1, "room.message.accepted", human(1, "OLD-COMPLETE-SENTINEL")),
    );
    let repairing = beginMessageAuthorityRepair(old, {
      snapshotId: "snapshot-fail",
      watermark: 5,
      generation: 2,
    });
    repairing = stageMessageAuthorityRepairRecord(
      repairing,
      "snapshot-fail",
      record(human(2, "partial staging")),
    );

    const retained = failMessageAuthorityRepair(repairing, {
      snapshotId: "snapshot-fail",
      authorization: "retained",
    });
    expect(retained.mode).toBe("online");
    expect((retained.timeline[0] as ActiveHumanMessage).currentRevision.body).toBe(
      "OLD-COMPLETE-SENTINEL",
    );
    expect(retained.generation).toBe(1);

    const locked = failMessageAuthorityRepair(repairing, {
      snapshotId: "snapshot-fail",
      authorization: "revoked",
    });
    expect(locked).toMatchObject({ mode: "locked", timeline: [], eventLedger: [] });
    expect(JSON.stringify(locked)).not.toContain("OLD-COMPLETE-SENTINEL");
  });

  it("rejects audit revision records and never stages raw revisions for operational repair", () => {
    const replica = beginMessageAuthorityRepair(
      createMessageAuthorityReplica("room-1"),
      { snapshotId: "snapshot-1", watermark: 2, generation: 2 },
    );
    const auditRecord: MessageAuthorityRepairRecord = {
      kind: "message-revision",
      roomId: "room-1",
      value: {
        messageId: "message-human",
        revision: 1,
        body: "AUDIT-RAW-SENTINEL",
        revisedAt: createdAt,
        revisedByActorId: "human-1",
      },
    };

    expect(() => stageMessageAuthorityRepairRecord(
      replica,
      "snapshot-1",
      auditRecord,
    )).toThrow(new MessageAuthorityReplicaError("audit_record_forbidden"));
    expect(JSON.stringify(replica)).not.toContain("AUDIT-RAW-SENTINEL");
  });

  it("keeps offline state read-only and clears all Room state on explicit revoke", () => {
    const online = applyMessageAuthorityEvent(
      createMessageAuthorityReplica("room-1"),
      event(1, "room.message.accepted", human(1, "ROOM-SECRET-SENTINEL")),
    );
    const offline = markMessageAuthorityOfflineReadOnly(online);
    expect(offline.mode).toBe("offline-read-only");
    expect(offline.timeline).toEqual(online.timeline);
    expect(() => applyMessageAuthorityEvent(
      offline,
      event(2, "room.message.revised", human(2)),
    )).toThrow(new MessageAuthorityReplicaError("room_read_only"));

    const revoked = revokeMessageAuthorityRoom(offline);
    expect(revoked).toMatchObject({
      mode: "locked",
      timeline: [],
      eventLedger: [],
      afterSeq: 0,
      checkpoint: 0,
    });
    expect(JSON.stringify(revoked)).not.toContain("ROOM-SECRET-SENTINEL");
  });
});
