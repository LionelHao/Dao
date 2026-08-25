import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSessionContext } from "./persistence/contracts.js";
import {
  executeProjectLoopFrame,
  ProjectLoopTransportError,
  type ProjectLoopAuthorityTransport,
} from "./project-loop-websocket.js";

const session: AuthenticatedSessionContext = {
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-1" },
};

describe("FT-09 authenticated Project Loop dispatch", () => {
  it("injects the authenticated Human command context and never trusts actor input", async () => {
    const executeMutation = vi.fn(async () => ({
      type: "project.mutation.ack" as const,
      requestId: "resolve-1",
      roomId: "room-1",
      projectId: "room-1",
      acceptedRevision: 2,
      eventIds: ["event-2"],
      replayed: false,
    }));
    const authority: ProjectLoopAuthorityTransport = {
      executeQuery: vi.fn(),
      executeMutation,
    };
    const frame = {
      type: "project.proposal.resolve" as const,
      requestId: "resolve-1",
      idempotencyKey: "idem-1",
      roomId: "room-1",
      projectId: "room-1",
      proposalId: "proposal-1",
      expectedRevision: 1,
      resolution: "confirmed" as const,
      reason: null,
    };

    await expect(executeProjectLoopFrame(session, frame, authority)).resolves.toMatchObject({
      type: "project.mutation.ack",
      requestId: "resolve-1",
    });
    expect(executeMutation).toHaveBeenCalledWith({
      ...session,
      kind: "human",
      requestId: "resolve-1",
      idempotencyKey: "idem-1",
    }, frame);
  });

  it("fails closed when the authority is absent or returns a malformed/wrong-room result", async () => {
    const frame = {
      type: "project.snapshot.read" as const,
      requestId: "snapshot-1",
      roomId: "room-1",
      projectId: "room-1",
      afterEventSeq: 0,
      limit: 32,
    };
    await expect(executeProjectLoopFrame(session, frame, undefined)).rejects.toMatchObject({
      code: "project_dependency_unavailable",
      status: 503,
    });
    await expect(executeProjectLoopFrame(session, frame, {
      executeQuery: async () => ({ type: "project.snapshot", requestId: "snapshot-1", snapshot: {
        recordVersion: "project-loop.v1", roomId: "room-2", projectId: "room-2",
        watermark: 0, goals: [], decisions: [], requests: [], obstacles: [], nextActions: [],
        proposals: [], confirmations: [], transferProposals: [], balls: [], capturedAt: "2026-08-25T00:00:00.000Z",
      }, events: [], nextEventSeq: 0 }),
      executeMutation: vi.fn(),
    })).rejects.toBeInstanceOf(ProjectLoopTransportError);
  });
});
