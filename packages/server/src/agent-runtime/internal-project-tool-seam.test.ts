import { describe, expect, it, vi } from "vitest";
import { createInternalProjectToolSeam } from "./internal-project-tool-seam.js";

describe("FT-09 internal Project tool seam", () => {
  it("stays dependency-closed when no FT-09 authority implementation is supplied", async () => {
    const seam = createInternalProjectToolSeam();
    await expect(seam.query({
      kind: "project.query",
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      roomId: "room-1",
      sourceSnapshotId: "snapshot-1",
      afterEventSeq: 0,
      limit: 20,
    })).resolves.toEqual({ status: "dependency_unavailable" });
    await expect(seam.command({} as never)).resolves.toEqual({ status: "dependency_unavailable" });
  });

  it("forwards only through the explicit server-private query and command ports", async () => {
    const query = vi.fn(async () => ({
      status: "ready" as const,
      snapshot: { revision: 4 } as never,
    }));
    const command = vi.fn(async () => ({ status: "accepted" as const, acceptedRevision: 5 }));
    const seam = createInternalProjectToolSeam({ query, command });
    const input = {
      kind: "project.query" as const,
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      roomId: "room-1",
      sourceSnapshotId: "snapshot-1",
      afterEventSeq: 0,
      limit: 20,
    };
    await expect(seam.query(input)).resolves.toEqual({ status: "ready", snapshot: { revision: 4 } });
    expect(query).toHaveBeenCalledWith(input);
    expect(command).not.toHaveBeenCalled();
  });
});
