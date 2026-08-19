import type { DatabaseSync } from "node:sqlite";
import type { Message } from "@native-im/core";

/**
 * Persists a pre-FT-03 message as an explicit no-target revision-one record.
 *
 * Legacy callers have no structured mentions, target outcomes, replies, or
 * attachments. Keeping the adapter here makes that absence explicit while
 * still satisfying the v16 message/revision/envelope invariants.
 */
export function createLegacyMessageAuthorityInserter(
  database: DatabaseSync,
): (message: Message) => void {
  const insertMessage = database.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertRevision = database.prepare(
    `INSERT INTO message_revisions (
       message_id, revision, body, revised_at, revised_by_actor_id
     ) VALUES (?, 1, ?, ?, ?)`,
  );
  const insertEnvelope = database.prepare(
    `INSERT INTO message_envelopes (
       message_id, room_id, message_kind, lifecycle, current_revision,
       revision_count, created_at, recalled_at, recalled_by_actor_id
     ) VALUES (?, ?, ?, 'active', 1, 1, ?, NULL, NULL)`,
  );
  return (message) => {
    insertMessage.run(
      message.id,
      message.roomId,
      message.authorId,
      message.authorKind,
      message.body,
      message.sentAt,
    );
    insertRevision.run(message.id, message.body, message.sentAt, message.authorId);
    insertEnvelope.run(
      message.id,
      message.roomId,
      message.authorKind === "human" ? "human" : "agent-final",
      message.sentAt,
    );
  };
}

export function insertLegacyMessageAuthorityRecord(
  database: DatabaseSync,
  message: Message,
): void {
  createLegacyMessageAuthorityInserter(database)(message);
}
