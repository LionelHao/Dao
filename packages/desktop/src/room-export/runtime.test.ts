import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createDesktopRoomExportRuntime } from "./runtime.js";
import type { RoomExportOpened } from "./stream-contracts.js";

const encoder = new TextEncoder();
const NOW = "2026-09-01T00:00:00.000Z";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function line(value: unknown): Uint8Array {
  return encoder.encode(`${canonical(value)}\n`);
}

function validExport(roomId = "room-1"): Uint8Array {
  const header = line({ type: "header", version: "dao.room-export.v1", exportId: "export-1",
    roomId, watermark: 9, startedAt: NOW });
  const record = line({ type: "record", category: "message", entityId: "message-1",
    revision: 1, payload: { body: "owner export corpus" } });
  const content = Uint8Array.from([...header, ...record]);
  const manifest = { type: "manifest", version: "dao.room-export.v1", exportId: "export-1",
    roomId, watermark: 9, recordCount: 1, byteLength: content.byteLength,
    categories: [{ category: "message", count: 1 }],
    contentDigest: createHash("sha256").update(content).digest("hex"), completedAt: NOW };
  return Uint8Array.from([...content, ...line({ ...manifest,
    manifestDigest: createHash("sha256").update(canonical(manifest)).digest("hex") })]);
}

function fixture(chunks: readonly Uint8Array[]) {
  const order: string[] = [];
  let index = 0;
  const transport = {
    open: vi.fn(async () => { order.push("open"); return { type: "room-export.opened" as const,
      requestId: "open-1", streamId: "stream-1", roomId: "room-1", chunkSize: 65_536 as const }; }),
    read: vi.fn(async (command: { requestId: string; streamId: string; offset: number }) => {
      order.push("read");
      const bytes = chunks[index++] ?? new Uint8Array();
      return { type: "room-export.chunk" as const, requestId: command.requestId,
        streamId: command.streamId, offset: command.offset, byteLength: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"), eof: index >= chunks.length };
    }),
    abort: vi.fn(async (command: { requestId: string; streamId: string }) => { order.push("abort");
      return { type: "room-export.aborted" as const, requestId: command.requestId,
        streamId: command.streamId }; }),
  };
  const file = { write: vi.fn(async () => { order.push("write"); }),
    sync: vi.fn(async () => { order.push("fsync"); }),
    close: vi.fn(async () => { order.push("close"); }) };
  const fs = { openTemporary: vi.fn(async () => { order.push("temp"); return file; }),
    rename: vi.fn(async () => { order.push("rename"); }),
    remove: vi.fn(async () => { order.push("remove"); }) };
  const saveDialog = { chooseDestination: vi.fn(async (name: string) => {
    order.push(`dialog:${name}`); return "/chosen/export.ndjson";
  }) };
  const runtime = createDesktopRoomExportRuntime({ transport, saveDialog, fs,
    randomId: () => "opaque-temp", createRequestId: (operation) => `${operation}-1`,
    now: () => new Date(NOW) });
  return { runtime, transport, saveDialog, fs, file, order };
}

describe("Desktop Owner Room export runtime", () => {
  it.each([
    [401, "authentication_required"],
    [403, "room_export_forbidden"],
    [409, "room_export_conflict"],
    [410, "room_export_access_revoked"],
    [429, "room_export_capacity_exceeded"],
    [503, "storage_unavailable"],
  ] as const)("keeps a %i open failure closed and never opens the native dialog", async (status, code) => {
    const target = fixture([validExport()]);
    target.transport.open.mockRejectedValueOnce(Object.assign(new Error("private authority detail"), {
      roomExportError: { status, code, ...(status === 429 ? { retryAfterMs: 1_000 } : {}) },
    }));
    await expect(target.runtime.save({ roomId: "room-1" })).rejects.toMatchObject({
      message: `Room export failed: ${status} ${code}`,
      roomExportError: { status, code },
    });
    expect(target.saveDialog.chooseDestination).not.toHaveBeenCalled();
    expect(target.fs.openTemporary).not.toHaveBeenCalled();
    expect(target.transport.read).not.toHaveBeenCalled();
  });

  it("authorizes before native dialog, streams bounded NDJSON, fsyncs, and atomically renames", async () => {
    const bytes = validExport();
    const split = Math.floor(bytes.byteLength / 2);
    const target = fixture([bytes.slice(0, split), bytes.slice(split)]);
    await expect(target.runtime.save({ roomId: "room-1" })).resolves.toEqual({
      status: "saved", roomId: "room-1",
    });
    expect(target.order).toEqual([
      "open", "dialog:dao-room-export-room-1-2026-09-01.ndjson", "temp",
      "read", "write", "read", "write", "fsync", "close", "rename",
    ]);
    expect(target.transport.read).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }));
    expect(target.transport.read).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ offset: split }));
    expect(target.fs.rename).toHaveBeenCalledWith(
      "/chosen/export.ndjson.part-opaque-temp", "/chosen/export.ndjson",
    );
  });

  it("aborts the server stream when native save is cancelled and touches no filesystem", async () => {
    const target = fixture([validExport()]);
    target.saveDialog.chooseDestination.mockResolvedValueOnce(undefined);
    await expect(target.runtime.save({ roomId: "room-1" })).resolves.toEqual({
      status: "cancelled", roomId: "room-1",
    });
    expect(target.transport.abort).toHaveBeenCalledOnce();
    expect(target.fs.openTemporary).not.toHaveBeenCalled();
    expect(target.transport.read).not.toHaveBeenCalled();
  });

  it("removes the partial temp and never publishes a final file after midstream revoke", async () => {
    const bytes = validExport();
    const target = fixture([bytes.slice(0, 64)]);
    target.transport.read
      .mockResolvedValueOnce({ type: "room-export.chunk", requestId: "read-1",
        streamId: "stream-1", offset: 0, byteLength: 64,
        base64: Buffer.from(bytes.slice(0, 64)).toString("base64"), eof: false })
      .mockRejectedValueOnce(Object.assign(new Error("/private/server/path"), {
        roomExportError: { status: 410, code: "room_export_access_revoked" },
      }));
    await expect(target.runtime.save({ roomId: "room-1" })).rejects.toMatchObject({
      roomExportError: { status: 410, code: "room_export_access_revoked" },
    });
    expect(target.fs.remove).toHaveBeenCalledWith("/chosen/export.ndjson.part-opaque-temp");
    expect(target.fs.rename).not.toHaveBeenCalled();
    expect(target.transport.abort).toHaveBeenCalledOnce();
  });

  it("fails closed on an offset mismatch or disconnect and removes the partial temp", async () => {
    for (const failure of ["offset", "disconnect"] as const) {
      const bytes = validExport();
      const target = fixture([bytes]);
      if (failure === "offset") {
        target.transport.read.mockResolvedValueOnce({ type: "room-export.chunk",
          requestId: "read-1", streamId: "stream-1", offset: 1,
          byteLength: bytes.byteLength, base64: Buffer.from(bytes).toString("base64"), eof: true });
      } else {
        target.transport.read.mockRejectedValueOnce(new Error("socket disconnected"));
      }
      await expect(target.runtime.save({ roomId: "room-1" })).rejects.toMatchObject({
        roomExportError: { status: 503,
          code: failure === "offset" ? "room_export_invalid_stream" : "storage_unavailable" },
      });
      expect(target.fs.remove).toHaveBeenCalledWith("/chosen/export.ndjson.part-opaque-temp");
      expect(target.fs.rename).not.toHaveBeenCalled();
      expect(target.transport.abort).toHaveBeenCalledOnce();
    }
  });

  it("rejects non-canonical, secret-bearing, or incomplete NDJSON and removes partial output", async () => {
    for (const bytes of [
      encoder.encode('{"type":"header", "roomId":"room-1"}\n'),
      line({ type: "record", category: "message", entityId: "message-1", revision: 1,
        payload: { authorization: "Bearer secret" } }),
      validExport().slice(0, -20),
    ]) {
      const target = fixture([bytes]);
      await expect(target.runtime.save({ roomId: "room-1" })).rejects.toMatchObject({
        roomExportError: { status: 503, code: "room_export_invalid_stream" },
      });
      expect(target.fs.remove).toHaveBeenCalledOnce();
      expect(target.fs.rename).not.toHaveBeenCalled();
    }
  });

  it("aborts active stream and removes temp when authorized state is invalidated", async () => {
    let release!: (value: never) => void;
    const pending = new Promise<never>((resolve) => { release = resolve; });
    const target = fixture([validExport()]);
    target.transport.read.mockImplementationOnce(async () => pending);
    const saving = target.runtime.save({ roomId: "room-1" });
    await vi.waitFor(() => expect(target.transport.read).toHaveBeenCalledOnce());
    await target.runtime.invalidateAuthorizedState();
    release(undefined as never);
    await expect(saving).rejects.toMatchObject({
      roomExportError: { status: 410, code: "room_export_access_revoked" },
    });
    expect(target.fs.remove).toHaveBeenCalledOnce();
    expect(target.fs.rename).not.toHaveBeenCalled();
  });

  it.each(["invalidateAuthorizedState", "close"] as const)(
    "uses the open request as a provisional stream so %s preempts a pending open",
    async (operation) => {
      let resolveOpen!: (value: RoomExportOpened) => void;
      const target = fixture([validExport()]);
      target.transport.open.mockImplementationOnce(() => new Promise((resolve) => {
        resolveOpen = resolve;
      }));
      const saving = target.runtime.save({ roomId: "room-1" });
      await vi.waitFor(() => expect(target.transport.open).toHaveBeenCalledOnce());

      await target.runtime[operation]();
      expect(target.transport.abort).toHaveBeenCalledWith(expect.objectContaining({
        type: "room-export.abort", streamId: "open-1",
      }));
      resolveOpen({ type: "room-export.opened", requestId: "open-1", streamId: "stream-1",
        roomId: "room-1", chunkSize: 65_536 });
      await expect(saving).rejects.toMatchObject({
        roomExportError: { status: 410, code: "room_export_access_revoked" },
      });
      expect(target.saveDialog.chooseDestination).not.toHaveBeenCalled();
      expect(target.fs.openTemporary).not.toHaveBeenCalled();
    },
  );

  it("keeps the first save active when the same-socket second open is capacity-limited", async () => {
    const bytes = validExport();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target = fixture([bytes]);
    target.transport.read.mockImplementationOnce(async (command) => {
      await gate;
      return { type: "room-export.chunk", requestId: command.requestId,
        streamId: command.streamId, offset: command.offset, byteLength: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"), eof: true };
    });
    const first = target.runtime.save({ roomId: "room-1" });
    await vi.waitFor(() => expect(target.transport.read).toHaveBeenCalledOnce());
    target.transport.open.mockRejectedValueOnce(Object.assign(new Error("capacity detail"), {
      roomExportError: { status: 429, code: "room_export_capacity_exceeded", retryAfterMs: 1_000 },
    }));
    await expect(target.runtime.save({ roomId: "room-2" })).rejects.toMatchObject({
      roomExportError: { status: 429, code: "room_export_capacity_exceeded", retryAfterMs: 1_000 },
    });
    expect(target.saveDialog.chooseDestination).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toEqual({ status: "saved", roomId: "room-1" });
  });
});
