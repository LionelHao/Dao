import {
  isProjectSourceRef,
  type ProjectSourceRef,
} from "@native-im/core";

export const CONFIRMED_PROJECT_CHECKPOINT_LIMITS = Object.freeze({
  maxPage: 128,
  maxSourceRefs: 32,
  maxCursorUtf16: 2_048,
});

export type ConfirmedProjectFactCheckpoint = Readonly<{
  recordVersion: "confirmed-project-checkpoint.v1";
  checkpointId: string;
  roomId: string;
  projectId: string;
  factKind: "goal" | "decision" | "request" | "next_action" | "blocker" | "open_question";
  factId: string;
  factRevision: number;
  state: "current" | "superseded" | "recalled_source";
  sourceRefs: readonly ProjectSourceRef[];
  confirmingHumanActorId: string | null;
  confirmedAt: string;
  lifecycleGeneration: number;
}>;

export type ConfirmedProjectFactCheckpointPage = Readonly<{
  roomId: string;
  checkpoints: readonly ConfirmedProjectFactCheckpoint[];
  nextCursor: string | null;
}>;

export interface ConfirmedProjectFactCheckpointAuthorityPort {
  listConfirmed(input: Readonly<{
    roomId: string;
    cursor: string | null;
    limit: number;
  }>): Promise<unknown>;
}

type UnknownRecord = Record<PropertyKey, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function cursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 &&
    value.length <= CONFIRMED_PROJECT_CHECKPOINT_LIMITS.maxCursorUtf16 &&
    ![...value].some((character) => character.charCodeAt(0) < 32));
}

export function isConfirmedProjectFactCheckpoint(
  value: unknown,
): value is ConfirmedProjectFactCheckpoint {
  if (!record(value) || !exact(value, [
    "recordVersion", "checkpointId", "roomId", "projectId", "factKind", "factId", "factRevision",
    "state", "sourceRefs", "confirmingHumanActorId", "confirmedAt", "lifecycleGeneration",
  ]) || value.recordVersion !== "confirmed-project-checkpoint.v1" || !identifier(value.checkpointId) ||
      !identifier(value.roomId) || value.projectId !== value.roomId ||
      !(value.factKind === "goal" || value.factKind === "decision" || value.factKind === "request" ||
        value.factKind === "next_action" || value.factKind === "blocker" || value.factKind === "open_question") ||
      !identifier(value.factId) || !positive(value.factRevision) ||
      !(value.state === "current" || value.state === "superseded" || value.state === "recalled_source") ||
      !Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0 ||
      value.sourceRefs.length > CONFIRMED_PROJECT_CHECKPOINT_LIMITS.maxSourceRefs ||
      !(value.confirmingHumanActorId === null || identifier(value.confirmingHumanActorId)) ||
      !timestamp(value.confirmedAt) || !nonnegative(value.lifecycleGeneration)) return false;
  const refs = new Set<string>();
  for (const source of value.sourceRefs) {
    if (!isProjectSourceRef(source) || source.roomId !== value.roomId) return false;
    const key = `${source.kind}\0${source.sourceId}\0${source.sourceRevision}`;
    if (refs.has(key)) return false;
    refs.add(key);
  }
  return (value.factKind !== "goal" && value.factKind !== "decision" && value.factKind !== "request") ||
    value.confirmingHumanActorId !== null;
}

function cloneCheckpoint(value: ConfirmedProjectFactCheckpoint): ConfirmedProjectFactCheckpoint {
  return Object.freeze({
    ...value,
    sourceRefs: Object.freeze(value.sourceRefs.map((source) => Object.freeze({ ...source }))),
  });
}

function parsePage(
  value: unknown,
  roomId: string,
  limit: number,
): ConfirmedProjectFactCheckpointPage | null {
  if (!record(value) || !exact(value, ["roomId", "checkpoints", "nextCursor"]) ||
      value.roomId !== roomId || !Array.isArray(value.checkpoints) || value.checkpoints.length > limit ||
      !cursor(value.nextCursor)) return null;
  const ids = new Set<string>();
  const checkpoints: ConfirmedProjectFactCheckpoint[] = [];
  for (const item of value.checkpoints) {
    if (!isConfirmedProjectFactCheckpoint(item) || item.roomId !== roomId || ids.has(item.checkpointId)) {
      return null;
    }
    ids.add(item.checkpointId);
    checkpoints.push(cloneCheckpoint(item));
  }
  return Object.freeze({
    roomId,
    checkpoints: Object.freeze(checkpoints),
    nextCursor: value.nextCursor,
  });
}

export function createConfirmedProjectFactCheckpointReader(options: Readonly<{
  authority: ConfirmedProjectFactCheckpointAuthorityPort;
}>): Readonly<{
  list(input: Readonly<{
    roomId: string;
    cursor: string | null;
    limit: number;
  }>): Promise<ConfirmedProjectFactCheckpointPage>;
}> {
  return Object.freeze({
    async list(input) {
      if (!record(input) || !exact(input, ["roomId", "cursor", "limit"]) ||
          !identifier(input.roomId) || !cursor(input.cursor) || !positive(input.limit) ||
          input.limit > CONFIRMED_PROJECT_CHECKPOINT_LIMITS.maxPage) {
        throw new TypeError("Confirmed project checkpoint query was invalid");
      }
      const candidate = await options.authority.listConfirmed(input);
      const page = parsePage(candidate, input.roomId, input.limit);
      if (page === null) throw new TypeError("Confirmed project checkpoint authority result was malformed");
      return page;
    },
  });
}
