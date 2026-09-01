import {
  isNotificationProjection,
  isNotificationRepairRecord,
  isNotificationStableEvent,
  type NotificationProjection,
  type NotificationRepairRecord,
  type NotificationStableEvent,
} from "@native-im/core";

export type NotificationReplicaFailureReason =
  | "invalid_recipient" | "invalid_event" | "event_conflict" | "event_gap"
  | "notification_conflict" | "revision_regression" | "room_read_only" | "replica_locked"
  | "repair_in_progress" | "repair_not_active" | "invalid_repair";

export class NotificationReplicaError extends Error {
  readonly reason: NotificationReplicaFailureReason;
  constructor(reason: NotificationReplicaFailureReason) {
    super(`Notification replica rejected: ${reason}`);
    this.name = "NotificationReplicaError";
    this.reason = reason;
  }
}

export type NotificationReplicaMode = "online" | "offline-read-only" | "repairing" | "locked";
export type NotificationRoomBadgeProjection = Readonly<{
  roomId: string;
  unreadCount: number;
  unhandledCount: number;
}>;
export type NotificationEventLedgerEntry = Readonly<{ eventId: string; streamSeq: number }>;
export type NotificationIdentityEventPosition = Readonly<{
  eventId: string;
  streamId: string;
  streamSeq: number;
}>;
export type NotificationRepairStage = Readonly<{
  snapshotId: string;
  watermark: number;
  generation: number;
  returnMode: "online" | "offline-read-only";
  notifications: readonly NotificationProjection[];
}>;
export type NotificationReplica = Readonly<{
  recipientActorId: string;
  mode: NotificationReplicaMode;
  offlineAsOf?: string;
  generation: number;
  checkpoint: number;
  afterSeq: number;
  notifications: readonly NotificationProjection[];
  roomBadges: readonly NotificationRoomBadgeProjection[];
  eventLedger: readonly NotificationEventLedgerEntry[];
  repair?: NotificationRepairStage;
}>;
export type NotificationRepairIdentity = Readonly<{
  snapshotId: string;
  watermark: number;
  generation: number;
}>;
export type NotificationListBootstrap = Readonly<{
  identityWatermark: number;
  notifications: readonly NotificationProjection[];
}>;
export type FailNotificationRepairInput = Readonly<{
  snapshotId: string;
  authorization: "retained" | "revoked";
}>;

function reject(reason: NotificationReplicaFailureReason): never {
  throw new NotificationReplicaError(reason);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function cloneProjection(value: NotificationProjection): NotificationProjection {
  return Object.freeze({ ...value, source: Object.freeze({ ...value.source }),
    deepLink: Object.freeze({ ...value.deepLink }), safeProjection: Object.freeze({ ...value.safeProjection }) });
}
function sortNotifications(values: readonly NotificationProjection[]): readonly NotificationProjection[] {
  return Object.freeze(values.map(cloneProjection).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || left.notificationId.localeCompare(right.notificationId)));
}
function deriveBadges(values: readonly NotificationProjection[]): readonly NotificationRoomBadgeProjection[] {
  const badges = new Map<string, { unreadCount: number; unhandledCount: number }>();
  for (const value of values) {
    const badge = badges.get(value.roomId) ?? { unreadCount: 0, unhandledCount: 0 };
    if (value.readAt === null) badge.unreadCount += 1;
    if (!value.handled) badge.unhandledCount += 1;
    badges.set(value.roomId, badge);
  }
  return Object.freeze([...badges].sort(([left], [right]) => left.localeCompare(right))
    .map(([roomId, value]) => Object.freeze({ roomId, ...value })));
}
function freezeLedger(values: readonly NotificationEventLedgerEntry[]): readonly NotificationEventLedgerEntry[] {
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}
function freezeStage(value: NotificationRepairStage): NotificationRepairStage {
  return Object.freeze({ ...value, notifications: sortNotifications(value.notifications) });
}
function freezeReplica(value: NotificationReplica): NotificationReplica {
  const notifications = sortNotifications(value.notifications);
  return Object.freeze({
    recipientActorId: value.recipientActorId,
    mode: value.mode,
    ...(value.offlineAsOf === undefined ? {} : { offlineAsOf: value.offlineAsOf }),
    generation: value.generation,
    checkpoint: value.checkpoint,
    afterSeq: value.afterSeq,
    notifications,
    roomBadges: deriveBadges(notifications),
    eventLedger: freezeLedger(value.eventLedger),
    ...(value.repair === undefined ? {} : { repair: freezeStage(value.repair) }),
  });
}
function assertMutable(replica: NotificationReplica): void {
  if (replica.mode === "offline-read-only") reject("room_read_only");
  if (replica.mode === "locked") reject("replica_locked");
  if (replica.mode === "repairing") reject("repair_in_progress");
}
function immutableProjection(value: NotificationProjection): unknown {
  return { recordVersion: value.recordVersion, notificationId: value.notificationId, roomId: value.roomId,
    recipientActorId: value.recipientActorId, notificationKind: value.notificationKind,
    source: value.source, dedupeKey: value.dedupeKey, createdAt: value.createdAt,
    sourceAccessible: value.sourceAccessible, deepLink: value.deepLink, safeProjection: value.safeProjection };
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Notification replica contained a non-canonical value");
}
function validateSet(values: readonly NotificationProjection[], recipientActorId: string): void {
  const ids = new Set<string>(); const dedupe = new Set<string>();
  for (const value of values) {
    if (!isNotificationProjection(value) || value.recipientActorId !== recipientActorId ||
        ids.has(value.notificationId) || dedupe.has(value.dedupeKey)) reject("invalid_repair");
    ids.add(value.notificationId); dedupe.add(value.dedupeKey);
  }
}

export function createNotificationReplica(recipientActorId: string): NotificationReplica {
  if (!identifier(recipientActorId)) reject("invalid_recipient");
  return freezeReplica({ recipientActorId, mode: "online", generation: 1, checkpoint: 0, afterSeq: 0,
    notifications: [], roomBadges: [], eventLedger: [] });
}

/** Installs a recipient list and principal-stream position as one projection boundary. */
export function installNotificationListBootstrap(
  replica: NotificationReplica,
  input: NotificationListBootstrap,
): NotificationReplica {
  if (replica.mode === "locked") reject("replica_locked");
  if (replica.mode === "repairing") reject("repair_in_progress");
  if (!nonNegativeInteger(input.identityWatermark) ||
      input.identityWatermark < replica.afterSeq) reject("revision_regression");
  validateSet(input.notifications, replica.recipientActorId);
  return freezeReplica({ ...replica, generation: replica.generation + 1,
    checkpoint: input.identityWatermark, afterSeq: input.identityWatermark,
    notifications: input.notifications, eventLedger: [] });
}

function reduceProjection(replica: NotificationReplica, event: NotificationStableEvent): readonly NotificationProjection[] {
  const index = replica.notifications.findIndex(({ notificationId }) => notificationId === event.payload.notificationId);
  if (event.type === "notification.revoked") {
    return index < 0 ? replica.notifications : replica.notifications.filter((_, candidate) => candidate !== index);
  }
  const value = event.payload;
  if (event.type === "notification.created") {
    if (index >= 0 || replica.notifications.some(({ dedupeKey }) => dedupeKey === value.dedupeKey)) {
      reject("notification_conflict");
    }
    return [...replica.notifications, value];
  }
  if (index < 0) reject("notification_conflict");
  const existing = replica.notifications[index]!;
  if (canonical(immutableProjection(existing)) !== canonical(immutableProjection(value))) {
    reject("notification_conflict");
  }
  if (value.readRevision < existing.readRevision || existing.readAt !== null && value.readAt === null ||
      existing.handled && !value.handled || existing.handledAt !== null && value.handledAt === null) {
    reject("revision_regression");
  }
  if (event.type === "notification.read" &&
      (value.readAt === null || value.readRevision <= existing.readRevision || value.handled !== existing.handled)) {
    reject("revision_regression");
  }
  if (event.type === "notification.handled" && (!value.handled || value.handledAt === null)) {
    reject("revision_regression");
  }
  const next = [...replica.notifications]; next[index] = value; return next;
}

export function applyNotificationEvent(
  replica: NotificationReplica,
  event: NotificationStableEvent,
): NotificationReplica {
  assertMutable(replica);
  if (!isNotificationStableEvent(event) || event.streamKind !== "identity" ||
      event.streamId !== replica.recipientActorId || event.payload.recipientActorId !== replica.recipientActorId) {
    reject("invalid_event");
  }
  const sameId = replica.eventLedger.find(({ eventId }) => eventId === event.eventId);
  if (sameId !== undefined) {
    if (sameId.streamSeq === event.streamSeq) return replica;
    reject("event_conflict");
  }
  if (replica.eventLedger.some(({ streamSeq }) => streamSeq === event.streamSeq)) reject("event_conflict");
  if (event.streamSeq <= replica.checkpoint) return replica;
  if (event.streamSeq <= replica.afterSeq) reject("event_conflict");
  if (event.streamSeq !== replica.afterSeq + 1) reject("event_gap");
  return freezeReplica({ ...replica, afterSeq: event.streamSeq,
    notifications: reduceProjection(replica, event),
    eventLedger: [...replica.eventLedger, { eventId: event.eventId, streamSeq: event.streamSeq }] });
}

/** Advances the principal cursor for a notification event outside the currently visible page. */
export function advanceNotificationIdentityCursor(
  replica: NotificationReplica,
  event: NotificationIdentityEventPosition,
): NotificationReplica {
  assertMutable(replica);
  if (!identifier(event.eventId) || event.streamId !== replica.recipientActorId ||
      !positiveInteger(event.streamSeq)) reject("invalid_event");
  const sameId = replica.eventLedger.find(({ eventId }) => eventId === event.eventId);
  if (sameId !== undefined) {
    if (sameId.streamSeq === event.streamSeq) return replica;
    reject("event_conflict");
  }
  if (replica.eventLedger.some(({ streamSeq }) => streamSeq === event.streamSeq)) reject("event_conflict");
  if (event.streamSeq <= replica.checkpoint) return replica;
  if (event.streamSeq <= replica.afterSeq) reject("event_conflict");
  if (event.streamSeq !== replica.afterSeq + 1) reject("event_gap");
  return freezeReplica({ ...replica, afterSeq: event.streamSeq,
    eventLedger: [...replica.eventLedger, { eventId: event.eventId, streamSeq: event.streamSeq }] });
}

export function beginNotificationRepair(
  replica: NotificationReplica,
  input: NotificationRepairIdentity,
): NotificationReplica {
  if (replica.mode === "locked") reject("replica_locked");
  if (replica.mode === "repairing") reject("repair_in_progress");
  if (!identifier(input.snapshotId) || !nonNegativeInteger(input.watermark) ||
      !positiveInteger(input.generation) || input.generation <= replica.generation) reject("invalid_repair");
  return freezeReplica({ ...replica, mode: "repairing",
    repair: { ...input, returnMode: replica.mode, notifications: [] } });
}
function activeRepair(replica: NotificationReplica, snapshotId: string): NotificationRepairStage {
  if (replica.mode !== "repairing" || replica.repair === undefined) reject("repair_not_active");
  if (replica.repair.snapshotId !== snapshotId) reject("invalid_repair");
  return replica.repair;
}
export function stageNotificationRepairRecord(
  replica: NotificationReplica,
  snapshotId: string,
  record: NotificationRepairRecord,
): NotificationReplica {
  return stageNotificationRepairPage(replica, snapshotId, [record]);
}
export function stageNotificationRepairPage(
  replica: NotificationReplica,
  snapshotId: string,
  records: readonly NotificationRepairRecord[],
): NotificationReplica {
  const repair = activeRepair(replica, snapshotId);
  const notificationIds = new Set(repair.notifications.map(({ notificationId }) => notificationId));
  const dedupeKeys = new Set(repair.notifications.map(({ dedupeKey }) => dedupeKey));
  const values: NotificationProjection[] = [];
  for (const record of records) {
    if (!isNotificationRepairRecord(record) || record.value.recipientActorId !== replica.recipientActorId ||
        notificationIds.has(record.value.notificationId) || dedupeKeys.has(record.value.dedupeKey)) {
      reject("invalid_repair");
    }
    notificationIds.add(record.value.notificationId); dedupeKeys.add(record.value.dedupeKey);
    values.push(record.value);
  }
  return freezeReplica({ ...replica, repair: { ...repair, notifications: [...repair.notifications, ...values] } });
}
export function commitNotificationRepair(
  replica: NotificationReplica,
  input: NotificationRepairIdentity,
): NotificationReplica {
  const repair = activeRepair(replica, input.snapshotId);
  if (repair.watermark !== input.watermark || repair.generation !== input.generation) reject("invalid_repair");
  validateSet(repair.notifications, replica.recipientActorId);
  return freezeReplica({ recipientActorId: replica.recipientActorId, mode: "online",
    generation: repair.generation, checkpoint: repair.watermark, afterSeq: repair.watermark,
    notifications: repair.notifications, roomBadges: [], eventLedger: [] });
}
export function failNotificationRepair(
  replica: NotificationReplica,
  input: FailNotificationRepairInput,
): NotificationReplica {
  const repair = activeRepair(replica, input.snapshotId);
  if (input.authorization === "revoked") {
    return freezeReplica({ recipientActorId: replica.recipientActorId, mode: "locked",
      generation: replica.generation, checkpoint: replica.checkpoint, afterSeq: replica.afterSeq,
      notifications: [], roomBadges: [], eventLedger: [] });
  }
  return freezeReplica({ recipientActorId: replica.recipientActorId, mode: repair.returnMode,
    ...(replica.offlineAsOf === undefined ? {} : { offlineAsOf: replica.offlineAsOf }),
    generation: replica.generation, checkpoint: replica.checkpoint, afterSeq: replica.afterSeq,
    notifications: replica.notifications, roomBadges: replica.roomBadges,
    eventLedger: replica.eventLedger });
}
export function markNotificationReplicaOffline(replica: NotificationReplica, asOf: string): NotificationReplica {
  if (replica.mode === "locked") reject("replica_locked");
  if (replica.mode === "repairing") reject("repair_in_progress");
  if (!identifier(asOf)) reject("invalid_event");
  return freezeReplica({ ...replica, mode: "offline-read-only", offlineAsOf: asOf });
}
