import type { DatabaseSync } from "node:sqlite";
import type {
  MessageAuthorityEvent,
  MessageAuthorityRepairRecord,
  MessageTargetRejectionCode,
  TimelineMessage,
} from "@native-im/core";

import {
  OperationalMessageProjectionError,
  projectOperationalMessageAuthorityEvent,
  projectOperationalMessageRepairRecord,
  projectOperationalTimelineMessage,
  type OperationalActiveHumanSource,
  type OperationalAgentMessageSource,
  type OperationalMessageEnvelopeRow,
  type OperationalMessageEventRow,
  type OperationalMessageProjectionSource,
  type OperationalRecalledHumanSource,
} from "./operational-projection.js";

type SqliteRow = Record<string, unknown>;
type SqliteStatement = ReturnType<DatabaseSync["prepare"]>;

type OperationalProjectionStatements = Readonly<{
  envelope: SqliteStatement;
  currentRevision: SqliteStatement;
  mentions: SqliteStatement;
  outcomes: SqliteStatement;
  reply: SqliteStatement;
  attachments: SqliteStatement;
  agentSource: SqliteStatement;
  agentCitations: SqliteStatement;
  correction: SqliteStatement;
}>;

const statementsByDatabase = new WeakMap<DatabaseSync, OperationalProjectionStatements>();

function statementsFor(database: DatabaseSync): OperationalProjectionStatements {
  const existing = statementsByDatabase.get(database);
  if (existing !== undefined) return existing;
  const statements = Object.freeze({
    envelope: database.prepare(
      `SELECT message.id AS messageId, message.room_id AS roomId,
              message.author_id AS authorId, message.author_kind AS authorKind,
              envelope.message_kind AS messageKind, envelope.lifecycle,
              envelope.current_revision AS currentRevision,
              envelope.revision_count AS revisionCount,
              envelope.created_at AS createdAt, envelope.recalled_at AS recalledAt
       FROM messages AS message
       JOIN message_envelopes AS envelope ON envelope.message_id = message.id
       WHERE message.id = ?`,
    ),
    currentRevision: database.prepare(
      `SELECT message_id AS messageId, revision, body,
              revised_at AS revisedAt, revised_by_actor_id AS revisedByActorId
       FROM message_revisions
       WHERE message_id = ? AND revision = (
         SELECT current_revision FROM message_envelopes WHERE message_id = ?
       )`,
    ),
    mentions: database.prepare(
      `SELECT target_id AS id, target_kind AS kind,
              target_actor_id AS targetActorId,
              range_start_utf16 AS startUtf16,
              range_end_utf16 AS endUtf16,
              target_order AS targetOrder
       FROM message_mentions
       WHERE message_id = ?
       ORDER BY target_order`,
    ),
    outcomes: database.prepare(
      `SELECT target_id AS targetId, target_actor_id AS targetActorId,
              target_kind AS kind, status,
              request_intent_id AS requestIntentId,
              invocation_intent_id AS invocationIntentId,
              rejection_code AS code
       FROM message_target_outcomes
       WHERE message_id = ?
       ORDER BY target_id`,
    ),
    reply: database.prepare(
      `SELECT reply_to_message_id AS replyToMessageId
       FROM message_reply_links WHERE message_id = ?`,
    ),
    attachments: database.prepare(
      `SELECT attachment_id AS attachmentId
       FROM message_attachment_links
       WHERE message_id = ? AND operational_state = 'active'
       ORDER BY attachment_id`,
    ),
    agentSource: database.prepare(
      `SELECT message_id AS messageId, room_id AS roomId,
              invocation_intent_id AS invocationIntentId,
              execution_id AS executionId, source_message_id AS sourceMessageId,
              source_revision AS sourceRevision, attempt_seq AS attemptSeq,
              execution_generation AS executionGeneration
       FROM agent_message_sources WHERE message_id = ?`,
    ),
    agentCitations: database.prepare(
      `SELECT ordinal + 1 AS ordinal, source_kind AS sourceKind,
              source_id AS sourceId, source_revision AS sourceRevision
       FROM agent_message_citations
       WHERE message_id = ?
       ORDER BY ordinal`,
    ),
    correction: database.prepare(
      `SELECT correction_message_id AS correctionMessageId,
              corrects_message_id AS correctsMessageId,
              room_id AS roomId, agent_actor_id AS agentActorId
       FROM agent_message_corrections WHERE correction_message_id = ?`,
    ),
  });
  statementsByDatabase.set(database, statements);
  return statements;
}

function invalidSource(): never {
  throw new OperationalMessageProjectionError("invalid_source");
}

function envelopeFromRow(row: SqliteRow): OperationalMessageEnvelopeRow {
  return {
    messageId: row.messageId as string,
    roomId: row.roomId as string,
    authorId: row.authorId as string,
    authorKind: row.authorKind as OperationalMessageEnvelopeRow["authorKind"],
    messageKind: row.messageKind as OperationalMessageEnvelopeRow["messageKind"],
    lifecycle: row.lifecycle as OperationalMessageEnvelopeRow["lifecycle"],
    currentRevision: row.currentRevision as number,
    revisionCount: row.revisionCount as number,
    createdAt: row.createdAt as string,
    recalledAt: row.recalledAt as string | null,
  };
}

function currentRevision(database: DatabaseSync, messageId: string): SqliteRow {
  return statementsFor(database).currentRevision.get(messageId, messageId) ?? invalidSource();
}

function activeHumanSource(
  database: DatabaseSync,
  envelope: OperationalMessageEnvelopeRow,
): OperationalActiveHumanSource {
  const statements = statementsFor(database);
  const mentionedTargets = statements.mentions.all(envelope.messageId).map((row) => ({
    id: row.id,
    kind: row.kind,
    targetActorId: row.targetActorId,
    range: { startUtf16: row.startUtf16, endUtf16: row.endUtf16 },
    targetOrder: row.targetOrder,
  }));
  const targetOutcomes = statements.outcomes.all(envelope.messageId).map(targetOutcome);
  const reply = statements.reply.get(envelope.messageId);
  const attachments = statements.attachments.all(envelope.messageId);
  return {
    kind: "active-human",
    envelope,
    currentRevision: currentRevision(database, envelope.messageId) as
      OperationalActiveHumanSource["currentRevision"],
    mentionedTargets: mentionedTargets as OperationalActiveHumanSource["mentionedTargets"],
    targetOutcomes: targetOutcomes as OperationalActiveHumanSource["targetOutcomes"],
    reply: reply === undefined
      ? null
      : { replyToMessageId: reply.replyToMessageId as string },
    attachments: attachments as unknown as OperationalActiveHumanSource["attachments"],
  };
}

function targetOutcome(row: SqliteRow): OperationalActiveHumanSource["targetOutcomes"][number] {
  if (row.status === "request-created") {
    return {
      targetId: row.targetId as string,
      targetActorId: row.targetActorId as string,
      kind: row.kind as "human-request",
      status: row.status,
      requestIntentId: row.requestIntentId as string,
    };
  }
  if (row.status === "invocation-intent-created") {
    return {
      targetId: row.targetId as string,
      targetActorId: row.targetActorId as string,
      kind: row.kind as "agent-invocation",
      status: row.status,
      invocationIntentId: row.invocationIntentId as string,
    };
  }
  return {
    targetId: row.targetId as string,
    targetActorId: row.targetActorId as string,
    kind: row.kind as "human-request" | "agent-invocation",
    status: "rejected",
    code: row.code as MessageTargetRejectionCode,
  };
}

function groupedRows(
  rows: readonly SqliteRow[],
): ReadonlyMap<string, readonly SqliteRow[]> {
  const groups = new Map<string, SqliteRow[]>();
  for (const row of rows) {
    if (typeof row.messageId !== "string") return invalidSource();
    const group = groups.get(row.messageId) ?? [];
    group.push(row);
    groups.set(row.messageId, group);
  }
  return groups;
}

function agentMessageSource(
  database: DatabaseSync,
  envelope: OperationalMessageEnvelopeRow,
): OperationalAgentMessageSource {
  const statements = statementsFor(database);
  const lineage = statements.agentSource.get(envelope.messageId);
  const citations = statements.agentCitations.all(envelope.messageId).map((row) => ({
    ordinal: row.ordinal,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceRevision: row.sourceRevision,
  }));
  const correction = statements.correction.get(envelope.messageId);
  if (envelope.messageKind === "agent-correction" &&
      (lineage === undefined || correction === undefined)) {
    return invalidSource();
  }

  // Explicit compatibility seam for migrated v1 Agent messages. The v16
  // backfill preserves them as immutable finals but intentionally cannot
  // invent historical invocation/execution rows from message body text.
  const sourceLineage = lineage ?? {
    messageId: envelope.messageId,
    roomId: envelope.roomId,
    invocationIntentId: `legacy:${envelope.messageId}:invocation`,
    executionId: `legacy:${envelope.messageId}:execution`,
    sourceMessageId: envelope.messageId,
    sourceRevision: 1,
    attemptSeq: 1,
    executionGeneration: 1,
  };
  return {
    kind: "agent-message",
    envelope,
    finalRevision: currentRevision(database, envelope.messageId) as
      OperationalAgentMessageSource["finalRevision"],
    sourceLineage: sourceLineage as OperationalAgentMessageSource["sourceLineage"],
    citations: citations as unknown as OperationalAgentMessageSource["citations"],
    correction: correction === undefined
      ? null
      : correction as OperationalAgentMessageSource["correction"],
  };
}

export function readOperationalMessageProjectionSource(
  database: DatabaseSync,
  messageId: string,
): OperationalMessageProjectionSource {
  const row = statementsFor(database).envelope.get(messageId);
  if (row === undefined) return invalidSource();
  const envelope = envelopeFromRow(row);
  if (envelope.lifecycle === "recalled") {
    const source: OperationalRecalledHumanSource = { kind: "recalled-human", envelope };
    return source;
  }
  if (envelope.messageKind === "human") return activeHumanSource(database, envelope);
  return agentMessageSource(database, envelope);
}

export function readOperationalMessageRepairPage(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    afterMessageId: string | undefined;
    limit: number;
  }>,
): readonly Extract<MessageAuthorityRepairRecord, {
  readonly kind: "timeline-message";
}>[] {
  if (input.roomId.length === 0 || input.roomId !== input.roomId.trim() ||
      (input.afterMessageId !== undefined && (input.afterMessageId.length === 0 ||
        input.afterMessageId !== input.afterMessageId.trim())) ||
      !Number.isSafeInteger(input.limit) || input.limit <= 0) {
    return invalidSource();
  }
  const afterClause = input.afterMessageId === undefined
    ? ""
    : " AND envelope.message_id > ?";
  const rows = database.prepare(
    `SELECT message.id AS messageId, message.room_id AS roomId,
            message.author_id AS authorId, message.author_kind AS authorKind,
            envelope.message_kind AS messageKind, envelope.lifecycle,
            envelope.current_revision AS currentRevision,
            envelope.revision_count AS revisionCount,
            envelope.created_at AS createdAt, envelope.recalled_at AS recalledAt,
            revision.message_id AS revisionMessageId, revision.revision,
            revision.body, revision.revised_at AS revisedAt,
            revision.revised_by_actor_id AS revisedByActorId,
            reply.reply_to_message_id AS replyToMessageId,
            source.message_id AS sourceLineageMessageId,
            source.room_id AS sourceLineageRoomId,
            source.invocation_intent_id AS invocationIntentId,
            source.execution_id AS executionId,
            source.source_message_id AS sourceMessageId,
            source.source_revision AS sourceRevision,
            source.attempt_seq AS attemptSeq,
            source.execution_generation AS executionGeneration,
            correction.correction_message_id AS correctionMessageId,
            correction.corrects_message_id AS correctsMessageId,
            correction.room_id AS correctionRoomId,
            correction.agent_actor_id AS correctionAgentActorId
     FROM message_envelopes AS envelope
     JOIN messages AS message ON message.id = envelope.message_id
     LEFT JOIN message_revisions AS revision
       ON envelope.lifecycle = 'active'
      AND revision.message_id = envelope.message_id
      AND revision.revision = envelope.current_revision
     LEFT JOIN message_reply_links AS reply ON reply.message_id = envelope.message_id
     LEFT JOIN agent_message_sources AS source ON source.message_id = envelope.message_id
     LEFT JOIN agent_message_corrections AS correction
       ON correction.correction_message_id = envelope.message_id
     WHERE envelope.room_id = ?${afterClause}
     ORDER BY envelope.message_id LIMIT ?`,
  ).all(
    input.roomId,
    ...(input.afterMessageId === undefined ? [] : [input.afterMessageId]),
    input.limit,
  );
  if (rows.length === 0) return Object.freeze([]);
  const firstId = rows[0]?.messageId;
  const lastId = rows.at(-1)?.messageId;
  if (typeof firstId !== "string" || typeof lastId !== "string") return invalidSource();
  const rangeParameters = [input.roomId, firstId, lastId] as const;
  const mentions = groupedRows(database.prepare(
    `SELECT message_id AS messageId, target_id AS id, target_kind AS kind,
            target_actor_id AS targetActorId,
            range_start_utf16 AS startUtf16,
            range_end_utf16 AS endUtf16, target_order AS targetOrder
     FROM message_mentions
     WHERE room_id = ? AND message_id >= ? AND message_id <= ?
     ORDER BY message_id, target_order`,
  ).all(...rangeParameters));
  const outcomes = groupedRows(database.prepare(
    `SELECT message_id AS messageId, target_id AS targetId,
            target_actor_id AS targetActorId, target_kind AS kind, status,
            request_intent_id AS requestIntentId,
            invocation_intent_id AS invocationIntentId,
            rejection_code AS code
     FROM message_target_outcomes
     WHERE room_id = ? AND message_id >= ? AND message_id <= ?
     ORDER BY message_id, target_id`,
  ).all(...rangeParameters));
  const attachments = groupedRows(database.prepare(
    `SELECT message_id AS messageId, attachment_id AS attachmentId
     FROM message_attachment_links
     WHERE room_id = ? AND message_id >= ? AND message_id <= ?
       AND operational_state = 'active'
     ORDER BY message_id, attachment_id`,
  ).all(...rangeParameters));
  const citations = groupedRows(database.prepare(
    `SELECT citation.message_id AS messageId, citation.ordinal + 1 AS ordinal,
            citation.source_kind AS sourceKind, citation.source_id AS sourceId,
            citation.source_revision AS sourceRevision
     FROM agent_message_citations AS citation
     JOIN messages AS message ON message.id = citation.message_id
     WHERE message.room_id = ? AND citation.message_id >= ? AND citation.message_id <= ?
     ORDER BY citation.message_id, citation.ordinal`,
  ).all(...rangeParameters));

  return Object.freeze(rows.map((row) => {
    const envelope = envelopeFromRow(row);
    let source: OperationalMessageProjectionSource;
    if (envelope.lifecycle === "recalled") {
      source = { kind: "recalled-human", envelope };
    } else if (envelope.messageKind === "human") {
      source = {
        kind: "active-human",
        envelope,
        currentRevision: {
          messageId: row.revisionMessageId as string,
          revision: row.revision as number,
          body: row.body as string,
          revisedAt: row.revisedAt as string,
          revisedByActorId: row.revisedByActorId as string,
        },
        mentionedTargets: (mentions.get(envelope.messageId) ?? []).map((mention) => ({
          id: mention.id as string,
          kind: mention.kind as "human-request" | "agent-invocation",
          targetActorId: mention.targetActorId as string,
          range: {
            startUtf16: mention.startUtf16 as number,
            endUtf16: mention.endUtf16 as number,
          },
          targetOrder: mention.targetOrder as number,
        })),
        targetOutcomes: (outcomes.get(envelope.messageId) ?? []).map(targetOutcome),
        reply: typeof row.replyToMessageId === "string"
          ? { replyToMessageId: row.replyToMessageId }
          : null,
        attachments: (attachments.get(envelope.messageId) ?? []).map((attachment) => ({
          attachmentId: attachment.attachmentId as string,
        })),
      };
    } else {
      const hasLineage = typeof row.sourceLineageMessageId === "string";
      if (envelope.messageKind === "agent-correction" && !hasLineage) return invalidSource();
      source = {
        kind: "agent-message",
        envelope,
        finalRevision: {
          messageId: row.revisionMessageId as string,
          revision: row.revision as number,
          body: row.body as string,
          revisedAt: row.revisedAt as string,
          revisedByActorId: row.revisedByActorId as string,
        },
        sourceLineage: hasLineage
          ? {
              messageId: row.sourceLineageMessageId as string,
              roomId: row.sourceLineageRoomId as string,
              invocationIntentId: row.invocationIntentId as string,
              executionId: row.executionId as string,
              sourceMessageId: row.sourceMessageId as string,
              sourceRevision: row.sourceRevision as number,
              attemptSeq: row.attemptSeq as number,
              executionGeneration: row.executionGeneration as number,
            }
          : {
              messageId: envelope.messageId,
              roomId: envelope.roomId,
              invocationIntentId: `legacy:${envelope.messageId}:invocation`,
              executionId: `legacy:${envelope.messageId}:execution`,
              sourceMessageId: envelope.messageId,
              sourceRevision: 1,
              attemptSeq: 1,
              executionGeneration: 1,
            },
        citations: (citations.get(envelope.messageId) ?? []).map((citation) => ({
          ordinal: citation.ordinal as number,
          sourceKind: citation.sourceKind as OperationalAgentMessageSource["citations"][number]["sourceKind"],
          sourceId: citation.sourceId as string,
          sourceRevision: citation.sourceRevision as number,
        })),
        correction: typeof row.correctionMessageId === "string"
          ? {
              correctionMessageId: row.correctionMessageId,
              correctsMessageId: row.correctsMessageId as string,
              roomId: row.correctionRoomId as string,
              agentActorId: row.correctionAgentActorId as string,
            }
          : null,
      };
    }
    return projectOperationalMessageRepairRecord(source);
  }));
}

export function readOperationalTimelineMessage(
  database: DatabaseSync,
  messageId: string,
): TimelineMessage {
  return projectOperationalTimelineMessage(
    readOperationalMessageProjectionSource(database, messageId),
  );
}

export function readOperationalMessageRepairRecord(
  database: DatabaseSync,
  messageId: string,
): Extract<MessageAuthorityRepairRecord, { readonly kind: "timeline-message" }> {
  return projectOperationalMessageRepairRecord(
    readOperationalMessageProjectionSource(database, messageId),
  );
}

export function readOperationalMessageAuthorityEvent(
  database: DatabaseSync,
  event: OperationalMessageEventRow,
  messageId: string,
): MessageAuthorityEvent {
  return projectOperationalMessageAuthorityEvent(
    event,
    readOperationalMessageProjectionSource(database, messageId),
  );
}
