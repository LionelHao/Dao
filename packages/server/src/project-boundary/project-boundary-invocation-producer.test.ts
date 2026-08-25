import { describe, expect, it, vi } from "vitest";
import { createFailClosedProjectBoundaryInvocationProducer } from
  "./project-boundary-invocation-producer.js";

const request = {
  purpose: "project_boundary_invocation" as const,
  boundaryId: "checkpoint:project-1:fact-7:3",
  boundaryKind: "checkpoint" as const,
  projectId: "room-1",
  roomId: "room-1",
  agentId: "agent-1",
  sourceFactId: "fact-7",
  sourceFactRevision: 3,
};

describe("fail-closed project-boundary invocation producer", () => {
  it("records one stable dependency-unavailable decision without creating an execution", async () => {
    const recordSuppressed = vi.fn(async (input: { requestSha256: string; decidedAt: string }) => ({
      boundaryId: request.boundaryId,
      roomId: request.roomId,
      status: "suppressed" as const,
      reason: "dependency_unavailable" as const,
      decidedAt: input.decidedAt,
    }));
    const producer = createFailClosedProjectBoundaryInvocationProducer({
      authority: { recordSuppressed },
      now: () => Date.parse("2026-08-25T00:00:00.000Z"),
    });

    await expect(producer.consume(request)).resolves.toEqual({
      boundaryId: request.boundaryId,
      roomId: request.roomId,
      status: "suppressed",
      reason: "dependency_unavailable",
      decidedAt: "2026-08-25T00:00:00.000Z",
    });
    expect(recordSuppressed).toHaveBeenCalledWith(expect.objectContaining({
      request,
      reason: "dependency_unavailable",
      requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("rejects malformed or mismatched authority data", async () => {
    const producer = createFailClosedProjectBoundaryInvocationProducer({
      authority: { recordSuppressed: vi.fn(async () => ({
        boundaryId: "another-boundary", roomId: "room-1", status: "suppressed" as const,
        reason: "dependency_unavailable" as const, decidedAt: "2026-08-25T00:00:00.000Z",
      })) },
    });
    await expect(producer.consume(request)).rejects.toThrow("authority result was malformed");
    await expect(producer.consume({ ...request, projectId: "another-project" }))
      .rejects.toThrow("request was malformed");
  });
});
