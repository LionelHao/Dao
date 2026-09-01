import { describe, expect, it } from "vitest";
import {
  isAuthorityWorkerRequest,
  isAuthorityWorkerResponse,
} from "../persistence/worker-protocol.js";

const now = Date.parse("2026-09-01T00:00:00.000Z");

describe("FT-14 closed diagnostics and Room export worker protocol", () => {
  it("closes diagnostics requests without a Room identifier or artifact bytes", () => {
    const request = {
      type: "authority.privacy-data",
      requestId: "privacy-1",
      operation: {
        version: 1,
        type: "privacy.diagnostics.read-closed",
        actorId: "admin-1",
        sessionFamilyId: "family-1",
        sessionId: "session-1",
        now,
        limit: 10_000,
      },
    };
    expect(isAuthorityWorkerRequest(request)).toBe(true);
    expect(isAuthorityWorkerRequest({
      ...request,
      operation: { ...request.operation, roomId: "room-secret" },
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      ...request,
      operation: { ...request.operation, limit: 10_001 },
    })).toBe(false);
    const withoutExactSession = Object.fromEntries(
      Object.entries(request.operation).filter(([key]) => key !== "sessionId"),
    );
    expect(isAuthorityWorkerRequest({ ...request, operation: withoutExactSession })).toBe(false);
  });

  it("requires exact owner bindings, fixed watermark, bounded page and scoped results", () => {
    const operation = {
      version: 1,
      type: "privacy.room-export.read-page",
      actorId: "owner-1",
      sessionFamilyId: "family-1",
      sessionId: "session-1",
      roomId: "room-1",
      tenantId: "deployment-singleton",
      accessRevision: 7,
      lifecycle: "active",
      exportId: "export-1",
      watermark: 42,
      startedAt: "2026-09-01T00:00:00.000Z",
      after: "c:WzAsImV2ZW50LTEiLDFd",
      limit: 256,
      now,
    };
    expect(isAuthorityWorkerRequest({
      type: "authority.privacy-data",
      requestId: "privacy-2",
      operation,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.privacy-data",
      requestId: "privacy-2",
      operation: { ...operation, tenantId: "foreign-tenant" },
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      type: "authority.privacy-data",
      requestId: "privacy-2",
      operation: { ...operation, limit: 257 },
    })).toBe(false);

    const result = {
      kind: "room-export-page",
      records: [{
        tenantId: "deployment-singleton",
        roomId: "room-1",
        category: "message",
        entityId: "event-1",
        revision: 1,
        payload: { body: "authorized" },
      }],
    };
    expect(isAuthorityWorkerResponse({
      type: "authority.privacy-data-result",
      requestId: "privacy-2",
      result,
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.privacy-data-result",
      requestId: "privacy-2",
      result: { ...result, records: [{ ...result.records[0], roomId: "room-foreign" }] },
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.privacy-data-result",
      requestId: "privacy-2",
      result: { ...result, secret: "forbidden" },
    })).toBe(false);
  });
});
