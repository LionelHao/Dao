export type AuthorityWorkerRequest =
  | { readonly type: "authority.initialize"; readonly requestId: string }
  | { readonly type: "authority.inspect-schema"; readonly requestId: string }
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

export function isAuthorityWorkerRequest(value: unknown): value is AuthorityWorkerRequest {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "authority.initialize":
    case "authority.inspect-schema":
    case "authority.close":
      return hasExactKeys(value, ["type", "requestId"]);
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
