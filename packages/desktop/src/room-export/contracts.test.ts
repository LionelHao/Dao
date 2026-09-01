import { describe, expect, it } from "vitest";

import {
  ROOM_EXPORT_IPC_CHANNELS,
  isRoomExportIntent,
  isRoomExportResult,
} from "./contracts.js";

describe("Room export closed renderer contract", () => {
  it("accepts only a roomId domain intent and never a path, URL, channel, or bytes", () => {
    expect(isRoomExportIntent({ roomId: "room-1" })).toBe(true);
    for (const value of [
      { roomId: "room-1", path: "/tmp/export.ndjson" },
      { roomId: "room-1", url: "file:///tmp/export.ndjson" },
      { roomId: "room-1", channel: "arbitrary" },
      { roomId: "room-1", bytes: new Uint8Array([1]) },
      { roomId: "../escape" },
    ]) expect(isRoomExportIntent(value)).toBe(false);
    expect(ROOM_EXPORT_IPC_CHANNELS).toEqual({ save: "room-export:save" });
  });

  it("returns only saved/cancelled domain state without a filesystem path", () => {
    expect(isRoomExportResult({ status: "saved", roomId: "room-1" })).toBe(true);
    expect(isRoomExportResult({ status: "cancelled", roomId: "room-1" })).toBe(true);
    expect(isRoomExportResult({ status: "saved", roomId: "room-1", path: "/private/export" }))
      .toBe(false);
  });
});
