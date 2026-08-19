import { constants } from "node:fs";
import { lstat as nodeLstat, open as nodeOpen } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  attachmentDetectedMime,
  isAttachmentSafeFilename,
  type AttachmentDetectedMime,
  type AttachmentError,
  type AttachmentFormat,
} from "@native-im/core";
import type { AttachmentSelectResult, AttachmentSelection } from "./contracts.js";

export const NATIVE_SELECTION_LIMITS = Object.freeze({
  maximumHandles: 16,
  handleTtlMs: 15 * 60 * 1_000,
});

export type NativeFileStat = Readonly<{
  kind: "regular-file" | "symbolic-link" | "other";
  byteSize: number;
  modifiedAtMs: number;
  device: number;
  inode: number;
}>;

export interface NativeFileHandle {
  stat(): Promise<NativeFileStat>;
  read(offset: number, maximumBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface NativeFileSystemPort {
  lstat(filePath: string): Promise<NativeFileStat>;
  openNoFollow(filePath: string): Promise<NativeFileHandle>;
}

export interface NativeOpenFileDialogPort {
  showOpenFile(policy: typeof ATTACHMENT_FILE_PICKER_POLICY): Promise<Readonly<{
    canceled: boolean;
    filePaths: readonly string[];
  }>>;
}

export const ATTACHMENT_FILE_PICKER_POLICY = Object.freeze({
  multiple: false,
  directories: false,
  allowedExtensions: Object.freeze(["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "txt", "csv"]),
});

export type PrivateAttachmentSelection = Readonly<{
  selectionHandle: string;
  filePath: string;
  displayName: string;
  format: AttachmentFormat;
  declaredMime: AttachmentDetectedMime;
  byteSize: number;
  expiresAtMs: number;
  uploadKey: string;
  expectedStat: NativeFileStat;
}>;

export class NativeSelectionFailure extends Error {
  readonly error: AttachmentError;
  constructor(error: AttachmentError, message = error.code) {
    super(message);
    this.name = "NativeSelectionFailure";
    this.error = error;
  }
}

const EXTENSIONS: Readonly<Record<string, AttachmentFormat>> = Object.freeze({
  pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg",
  docx: "docx", xlsx: "xlsx", txt: "txt", csv: "csv",
});

function attachmentFormat(fileName: string): AttachmentFormat | undefined {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? undefined : EXTENSIONS[fileName.slice(dot + 1).toLowerCase()];
}

function sameFile(before: NativeFileStat, after: NativeFileStat): boolean {
  return before.kind === "regular-file" && after.kind === "regular-file" &&
    before.byteSize === after.byteSize && before.modifiedAtMs === after.modifiedAtMs &&
    before.device === after.device && before.inode === after.inode;
}

function publicSelection(entry: PrivateAttachmentSelection): AttachmentSelection {
  return Object.freeze({
    selectionHandle: entry.selectionHandle,
    displayName: entry.displayName,
    format: entry.format,
    declaredMime: entry.declaredMime,
    byteSize: entry.byteSize,
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
  });
}

function selectionGone(): NativeSelectionFailure {
  return new NativeSelectionFailure({ status: 410, code: "upload_expired" });
}

export interface NativeSelectionRegistry {
  select(): Promise<AttachmentSelectResult>;
  publicSelection(selectionHandle: string): Promise<AttachmentSelection>;
  getPrivateSelection(selectionHandle: string): PrivateAttachmentSelection;
  openForRead(selectionHandle: string): Promise<NativeFileHandle>;
  remove(selectionHandle: string): Promise<void>;
  invalidate(): Promise<void>;
}

export function createNativeSelectionRegistry(options: {
  readonly dialog: NativeOpenFileDialogPort;
  readonly fs: NativeFileSystemPort;
  readonly now?: () => number;
  readonly randomId?: () => string;
}): NativeSelectionRegistry {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const entries = new Map<string, PrivateAttachmentSelection>();
  const readers = new Map<string, Set<NativeFileHandle>>();

  function purgeExpired(): void {
    const current = now();
    for (const [handle, entry] of entries) {
      if (entry.expiresAtMs < current) {
        entries.delete(handle);
        const opened = readers.get(handle);
        readers.delete(handle);
        if (opened) for (const reader of opened) void reader.close().catch(() => undefined);
      }
    }
  }

  function privateSelection(selectionHandle: string): PrivateAttachmentSelection {
    purgeExpired();
    const entry = entries.get(selectionHandle);
    if (!entry) throw selectionGone();
    return entry;
  }

  async function closeReaders(selectionHandle: string): Promise<void> {
    const opened = readers.get(selectionHandle);
    readers.delete(selectionHandle);
    if (opened) await Promise.allSettled([...opened].map((reader) => reader.close()));
  }

  const registry: NativeSelectionRegistry = {
    async select() {
      purgeExpired();
      if (entries.size >= NATIVE_SELECTION_LIMITS.maximumHandles) {
        throw new NativeSelectionFailure({
          status: 429,
          code: "attachment_capacity_limited",
          retryAfterSeconds: 60,
        });
      }
      const chosen = await options.dialog.showOpenFile(ATTACHMENT_FILE_PICKER_POLICY);
      if (chosen.canceled) return Object.freeze({ status: "cancelled" as const });
      if (chosen.filePaths.length !== 1) {
        throw new NativeSelectionFailure({ status: 400, code: "invalid_request" });
      }
      const filePath = chosen.filePaths[0];
      if (typeof filePath !== "string" || filePath.length === 0) {
        throw new NativeSelectionFailure({ status: 400, code: "invalid_request" });
      }
      const displayName = basename(filePath);
      const format = attachmentFormat(displayName);
      if (!format || !isAttachmentSafeFilename(displayName)) {
        throw new NativeSelectionFailure({ status: 415, code: "attachment_type_unsupported" });
      }
      const before = await options.fs.lstat(filePath);
      if (before.kind !== "regular-file") {
        throw new NativeSelectionFailure({ status: 400, code: "invalid_request" });
      }
      if (!Number.isSafeInteger(before.byteSize) || before.byteSize < 0) {
        throw new NativeSelectionFailure({ status: 400, code: "invalid_request" });
      }
      if (before.byteSize === 0) {
        throw new NativeSelectionFailure({ status: 422, code: "attachment_malformed" });
      }
      if (before.byteSize > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes) {
        throw new NativeSelectionFailure({ status: 413, code: "attachment_too_large" });
      }

      const verified = await options.fs.openNoFollow(filePath);
      try {
        const after = await verified.stat();
        if (!sameFile(before, after)) {
          throw new NativeSelectionFailure({ status: 409, code: "idempotency_conflict" });
        }
      } finally {
        await verified.close();
      }

      const selectionHandle = randomId();
      const uploadKey = randomId();
      if (!selectionHandle || !uploadKey || selectionHandle === uploadKey || entries.has(selectionHandle)) {
        throw new NativeSelectionFailure({ status: 400, code: "invalid_request" });
      }
      const entry: PrivateAttachmentSelection = Object.freeze({
        selectionHandle,
        filePath,
        displayName,
        format,
        declaredMime: attachmentDetectedMime(format),
        byteSize: before.byteSize,
        expiresAtMs: now() + NATIVE_SELECTION_LIMITS.handleTtlMs,
        uploadKey,
        expectedStat: before,
      });
      entries.set(selectionHandle, entry);
      return Object.freeze({ status: "selected" as const, selection: publicSelection(entry) });
    },
    async publicSelection(selectionHandle) {
      return publicSelection(privateSelection(selectionHandle));
    },
    getPrivateSelection: privateSelection,
    async openForRead(selectionHandle) {
      const entry = privateSelection(selectionHandle);
      const beforeOpen = await options.fs.lstat(entry.filePath);
      if (!sameFile(entry.expectedStat, beforeOpen)) {
        throw new NativeSelectionFailure({ status: 409, code: "idempotency_conflict" });
      }
      const opened = await options.fs.openNoFollow(entry.filePath);
      const afterOpen = await opened.stat();
      if (!sameFile(entry.expectedStat, afterOpen)) {
        await opened.close();
        throw new NativeSelectionFailure({ status: 409, code: "idempotency_conflict" });
      }
      let set = readers.get(selectionHandle);
      if (!set) {
        set = new Set();
        readers.set(selectionHandle, set);
      }
      set.add(opened);
      return opened;
    },
    async remove(selectionHandle) {
      entries.delete(selectionHandle);
      await closeReaders(selectionHandle);
    },
    async invalidate() {
      entries.clear();
      await Promise.all([...readers.keys()].map(closeReaders));
    },
  };
  return Object.freeze(registry);
}

function statShape(value: Awaited<ReturnType<typeof nodeLstat>>): NativeFileStat {
  return Object.freeze({
    kind: value.isSymbolicLink() ? "symbolic-link" : value.isFile() ? "regular-file" : "other",
    byteSize: Number(value.size),
    modifiedAtMs: Number(value.mtimeMs),
    device: Number(value.dev),
    inode: Number(value.ino),
  });
}

export const NODE_NATIVE_FILE_SYSTEM: NativeFileSystemPort = Object.freeze<NativeFileSystemPort>({
  async lstat(filePath) {
    return statShape(await nodeLstat(filePath));
  },
  async openNoFollow(filePath) {
    const descriptor = await nodeOpen(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let closed = false;
    return Object.freeze({
      async stat() { return statShape(await descriptor.stat()); },
      async read(offset: number, maximumBytes: number) {
        if (closed || !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 ||
          maximumBytes > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes) {
          throw new TypeError("Invalid bounded native file read");
        }
        const buffer = new Uint8Array(maximumBytes);
        const result = await descriptor.read(buffer, 0, maximumBytes, offset);
        return buffer.slice(0, result.bytesRead);
      },
      async close() {
        if (closed) return;
        closed = true;
        await descriptor.close();
      },
    });
  },
});
