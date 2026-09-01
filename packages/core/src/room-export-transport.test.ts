import { describe, expect, it } from "vitest";
import {
  isRoomExportTransportServerFrame,
  parseRoomExportTransportClientFrame,
  ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES,
} from "./room-export-transport.js";

describe("Room export transport closed protocol", () => {
  it("accepts only exact open/read/abort requests", () => {
    expect(parseRoomExportTransportClientFrame({
      type: "room-export.open", requestId: "request-1", roomId: "room-1",
    }).ok).toBe(true);
    expect(parseRoomExportTransportClientFrame({
      type: "room-export.read", requestId: "request-2", streamId: "stream-1", offset: 0,
    }).ok).toBe(true);
    expect(parseRoomExportTransportClientFrame({
      type: "room-export.abort", requestId: "request-3", streamId: "stream-1",
    }).ok).toBe(true);
    expect(parseRoomExportTransportClientFrame({
      type: "room-export.open", requestId: "request-4", roomId: "room-1", actorId: "owner",
    }).ok).toBe(false);
    expect(parseRoomExportTransportClientFrame({
      type: "room-export.read", requestId: "request-5", streamId: "stream-1", offset: -1,
    }).ok).toBe(false);
  });

  it("closes chunk bytes to canonical base64 and 64 KiB", () => {
    const bytes = Buffer.alloc(ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES, 7);
    expect(isRoomExportTransportServerFrame({
      type: "room-export.chunk", requestId: "request-1", streamId: "stream-1",
      offset: 0, byteLength: bytes.byteLength, base64: bytes.toString("base64"), eof: false,
    })).toBe(true);
    const oversized = Buffer.alloc(ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES + 1, 7);
    expect(isRoomExportTransportServerFrame({
      type: "room-export.chunk", requestId: "request-1", streamId: "stream-1",
      offset: 0, byteLength: oversized.byteLength, base64: oversized.toString("base64"), eof: false,
    })).toBe(false);
    expect(isRoomExportTransportServerFrame({
      type: "room-export.chunk", requestId: "request-1", streamId: "stream-1",
      offset: 0, byteLength: 1, base64: "YQ", eof: true,
    })).toBe(false);
  });
});
