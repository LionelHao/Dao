export type AuthorityWorkerRequest =
  | { readonly type: "authority.initialize"; readonly requestId: string }
  | { readonly type: "authority.inspect-schema"; readonly requestId: string }
  | {
      readonly type: "authority.import-legacy";
      readonly requestId: string;
      readonly sessionFilePath: string;
      readonly roomFilePath: string;
      readonly messageFilePath: string;
    }
  | { readonly type: "authority.inspect-legacy-import"; readonly requestId: string }
  | { readonly type: "authority.close"; readonly requestId: string };

export type AuthorityWorkerResponse =
  | {
      readonly type: "authority.ready";
      readonly requestId: string;
      readonly schemaVersion: 2;
    }
  | {
      readonly type: "authority.schema";
      readonly requestId: string;
      readonly schemaVersion: 2;
    }
  | {
      readonly type: "authority.legacy-imported";
      readonly requestId: string;
      readonly imported: boolean;
      readonly actors: number;
      readonly rooms: number;
      readonly messages: number;
    }
  | {
      readonly type: "authority.legacy-import";
      readonly requestId: string;
      readonly markerVersion: 1;
      readonly actors: number;
      readonly rooms: number;
      readonly messages: number;
      readonly roomHeadSeq: number;
      readonly identityHeadSeq: number;
    }
  | { readonly type: "authority.closed"; readonly requestId: string }
  | {
      readonly type: "authority.error";
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function hasRequestId(value: Record<string, unknown>): boolean {
  return typeof value.requestId === "string" && value.requestId.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isAuthorityWorkerRequest(value: unknown): value is AuthorityWorkerRequest {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "authority.initialize":
    case "authority.inspect-schema":
    case "authority.inspect-legacy-import":
    case "authority.close":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.import-legacy":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "sessionFilePath",
          "roomFilePath",
          "messageFilePath",
        ]) &&
        typeof value.sessionFilePath === "string" &&
        value.sessionFilePath.length > 0 &&
        typeof value.roomFilePath === "string" &&
        value.roomFilePath.length > 0 &&
        typeof value.messageFilePath === "string" &&
        value.messageFilePath.length > 0
      );
    default:
      return false;
  }
}

export function isAuthorityWorkerResponse(
  value: unknown,
): value is AuthorityWorkerResponse {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "authority.ready":
    case "authority.schema":
      return (
        hasExactKeys(value, ["type", "requestId", "schemaVersion"]) &&
        value.schemaVersion === 2
      );
    case "authority.closed":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.legacy-imported":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "imported",
          "actors",
          "rooms",
          "messages",
        ]) &&
        typeof value.imported === "boolean" &&
        isNonNegativeSafeInteger(value.actors) &&
        isNonNegativeSafeInteger(value.rooms) &&
        isNonNegativeSafeInteger(value.messages)
      );
    case "authority.legacy-import":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "markerVersion",
          "actors",
          "rooms",
          "messages",
          "roomHeadSeq",
          "identityHeadSeq",
        ]) &&
        value.markerVersion === 1 &&
        isNonNegativeSafeInteger(value.actors) &&
        isNonNegativeSafeInteger(value.rooms) &&
        isNonNegativeSafeInteger(value.messages) &&
        isNonNegativeSafeInteger(value.roomHeadSeq) &&
        isNonNegativeSafeInteger(value.identityHeadSeq)
      );
    case "authority.error":
      return (
        hasExactKeys(value, ["type", "requestId", "code", "message"]) &&
        typeof value.code === "string" &&
        value.code.length > 0 &&
        typeof value.message === "string" &&
        value.message.length > 0
      );
    default:
      return false;
  }
}
