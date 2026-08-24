import { describe, expect, it } from "vitest";
import {
  isRoomAssignmentOperation,
  isRoomAssignmentResult,
} from "./authority-protocol.js";

const session = {
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-owner" },
};

describe("Room Assignment authority protocol", () => {
  it("accepts only the closed v1 command and query shapes", () => {
    const create = {
      version: 1, type: "room-assignment.mutate", context: session, now: 1,
      request: {
        kind: "create", requestId: "request-1", idempotencyKey: "key-1",
        roomId: "room-1", expectedRoomRevision: 1, profileId: "profile-1",
        participation: "on-mention", roomResponsibility: "Review evidence",
        capabilitySubset: ["room.respond"], toolSubset: ["room-memory.read"],
      },
    } as const;
    expect(isRoomAssignmentOperation(create)).toBe(true);
    expect(isRoomAssignmentOperation({ ...create, clientAvailability: "ready" })).toBe(false);
    expect(isRoomAssignmentOperation({
      ...create, request: { ...create.request, participation: "silent" },
    })).toBe(false);
    expect(isRoomAssignmentOperation({
      version: 1, type: "room-assignment.list", context: session, roomId: "room-1", now: 1,
    })).toBe(true);
    expect(isRoomAssignmentOperation({
      version: 1, type: "room-assignment.get", context: session, roomId: "room-1",
      assignmentId: "assignment-1", now: 1,
    })).toBe(true);
  });

  it("keeps command ACKs separate from stable Assignment facts", () => {
    expect(isRoomAssignmentResult({
      kind: "room-assignment-command",
      acknowledgement: {
        requestId: "request-1", changed: true, assignmentId: "assignment-1",
        acceptedRevision: 1, roomRevision: 2, eventIds: ["event-1"],
      },
    })).toBe(true);
    expect(isRoomAssignmentResult({
      kind: "room-assignment-command",
      acknowledgement: {
        requestId: "request-1", changed: true, assignmentId: "assignment-1",
        acceptedRevision: 1, roomRevision: 2, eventIds: [],
      },
    })).toBe(false);
  });
});
