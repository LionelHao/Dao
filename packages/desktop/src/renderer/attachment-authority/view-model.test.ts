import { describe, expect, it } from "vitest";
import {
  createAttachmentAuthorityViewModel,
  type AttachmentAuthorityInput,
  type AttachmentClosedError,
  type AttachmentVisibleState,
} from "./view-model.js";

const metadata = {
  displayName: "migration-notes.pdf",
  byteSize: 4_404_019,
  mediaType: "application/pdf",
} as const;

function input(overrides: Partial<AttachmentAuthorityInput> = {}): AttachmentAuthorityInput {
  return {
    localTransport: { status: "selected" },
    durable: { status: "open" },
    sourceEligibility: "unbound",
    accessProjection: "authorized",
    metadata,
    reducedMotion: false,
    ...overrides,
  };
}

function actionKinds(value: AttachmentAuthorityInput): readonly string[] {
  return createAttachmentAuthorityViewModel(value).actions.map((action) => action.kind);
}

describe("FT-04 J-02 four-axis visible-state contract", () => {
  it.each([
    ["local-selected", input()],
    ["uploading", input({
      localTransport: { status: "uploading", acknowledgedBytes: 1_835_008, totalBytes: metadata.byteSize },
    })],
    ["processing", input({
      localTransport: { status: "none" },
      durable: { status: "processing", phase: "ocr", authoritySource: "stable-event" },
    })],
    ["ready", input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
    })],
    ["retryable-failure", input({
      localTransport: { status: "none" },
      durable: {
        status: "retryable-failed",
        authoritySource: "projection",
        error: { status: 503, code: "scanner_unavailable" },
      },
    })],
    ["nonretryable-failure", input({
      localTransport: { status: "none" },
      durable: {
        status: "nonretryable-failed",
        authoritySource: "stable-event",
        error: { status: 422, code: "encrypted_pdf" },
      },
    })],
    ["cancelled", input({
      localTransport: { status: "none" },
      durable: { status: "cancelled", authoritySource: "projection" },
    })],
    ["size-type-rejected", input({
      localTransport: {
        status: "local-rejected",
        error: { status: 413, code: "attachment_too_large" },
      },
    })],
    ["malware-rejected", input({
      localTransport: { status: "none" },
      durable: { status: "malware-rejected", authoritySource: "stable-event" },
    })],
    ["permission-revoked", input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
      accessProjection: "permission-revoked",
    })],
  ] satisfies readonly (readonly [AttachmentVisibleState, AttachmentAuthorityInput])[])(
    "maps the axes to %s",
    (expected, value) => {
      const model = createAttachmentAuthorityViewModel(value);
      expect(model.visibleState).toBe(expected);
      expect(model.statusLabel.length).toBeGreaterThan(0);
      expect(model.nonColourCue).toMatch(/ICON|LINE|LOCK/u);
    },
  );

  it("applies the frozen precedence without manufacturing ready from local completion", () => {
    const uploaded = createAttachmentAuthorityViewModel(input({
      localTransport: {
        status: "uploading",
        acknowledgedBytes: metadata.byteSize,
        totalBytes: metadata.byteSize,
      },
    }));
    expect(uploaded.visibleState).toBe("uploading");
    expect(uploaded.statusLabel).not.toContain("READY");

    const malware = createAttachmentAuthorityViewModel(input({
      localTransport: {
        status: "transport-failed",
        error: { status: 503, code: "storage_unavailable" },
      },
      durable: { status: "malware-rejected", authoritySource: "stable-event" },
    }));
    expect(malware.visibleState).toBe("malware-rejected");

    const revoked = createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      durable: { status: "malware-rejected", authoritySource: "stable-event" },
      accessProjection: "permission-revoked",
    }));
    expect(revoked.visibleState).toBe("permission-revoked");
    expect(revoked.metadata).toBeUndefined();
  });

  it("uses only acknowledged server bytes for bounded progress and never live-announces chunks", () => {
    const model = createAttachmentAuthorityViewModel(input({
      localTransport: { status: "uploading", acknowledgedBytes: 1_835_008, totalBytes: metadata.byteSize },
    }));
    expect(model.progress).toEqual({
      acknowledgedBytes: 1_835_008,
      totalBytes: metadata.byteSize,
      percentage: 41,
    });
    expect(model.authority).toEqual({ kind: "server-ack", label: "SERVER ACK · chunk checkpoint" });
    expect(model.liveAnnouncement).toBe("附件上传中，可取消。");
    expect(model.liveAnnouncement).not.toMatch(/\d|%|byte/iu);
  });

  it("rejects impossible progress and an ACK-only ready claim", () => {
    expect(() => createAttachmentAuthorityViewModel(input({
      localTransport: { status: "uploading", acknowledgedBytes: metadata.byteSize + 1, totalBytes: metadata.byteSize },
    }))).toThrow(/progress/iu);
    expect(() => createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "server-ack" },
    }))).toThrow(/ready.*stable|projection/iu);
  });
});

describe("FT-04 action eligibility and lifecycle modifiers", () => {
  it("keeps each authority operation closed by visible fact and source eligibility", () => {
    expect(actionKinds(input())).toEqual(["upload", "remove"]);
    expect(actionKinds(input({
      localTransport: { status: "uploading", acknowledgedBytes: 1, totalBytes: metadata.byteSize },
    }))).toEqual(["cancel"]);
    expect(actionKinds(input({
      localTransport: { status: "none" },
      durable: { status: "processing", phase: "extracting", authoritySource: "projection" },
    }))).toEqual(["cancel"]);
    expect(actionKinds(input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
    }))).toEqual(["bind", "remove"]);
    expect(actionKinds(input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
      sourceEligibility: "bound-active",
    }))).toEqual(["preview", "download"]);
  });

  it("makes archive read-only, offline/repair fail closed, and recall absent from ordinary UI", () => {
    const boundReady = {
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
      sourceEligibility: "bound-active",
    } as const;
    const archived = createAttachmentAuthorityViewModel(input({
      ...boundReady,
      accessProjection: "archived-read-only",
    }));
    expect(archived.actions.map((action) => action.kind)).toEqual(["preview", "download"]);
    expect(archived.readOnly).toBe(true);
    expect(archived.accessLabel).toContain("ARCHIVED");

    for (const accessProjection of ["offline", "repairing"] as const) {
      const model = createAttachmentAuthorityViewModel(input({ ...boundReady, accessProjection }));
      expect(model.actions).toEqual([]);
      expect(model.readOnly).toBe(true);
      expect(model.accessLabel).toMatch(/OFFLINE|REPAIRING/u);
    }

    const recalled = createAttachmentAuthorityViewModel(input({
      ...boundReady,
      sourceEligibility: "excluded-recalled",
    }));
    expect(recalled.visibility).toBe("excluded");
    expect(recalled.actions).toEqual([]);
    expect(recalled.metadata).toBeUndefined();
  });
});

describe("FT-04 exact closed-error recovery", () => {
  const cases = [
    [{ status: 401, code: "unauthenticated" }, "retryable-failure", "reauthenticate"],
    [{ status: 403, code: "attachment_forbidden" }, "permission-revoked", "reauthenticate"],
    [{ status: 409, code: "upload_offset_conflict" }, "retryable-failure", "refresh-projection"],
    [{ status: 410, code: "upload_expired" }, "nonretryable-failure", "restart-upload"],
    [{ status: 413, code: "attachment_too_large" }, "size-type-rejected", "select-replacement"],
    [{ status: 413, code: "chunk_too_large" }, "size-type-rejected", "upgrade-client"],
    [{ status: 415, code: "type_mismatch" }, "size-type-rejected", "select-replacement"],
    [{ status: 422, code: "archive_bomb" }, "nonretryable-failure", "select-replacement"],
    [{ status: 429, code: "attachment_capacity_limited", retryAfterSeconds: 12 }, "retryable-failure", "retry"],
    [{ status: 503, code: "ocr_unavailable" }, "retryable-failure", "retry"],
  ] as const satisfies readonly (readonly [AttachmentClosedError, AttachmentVisibleState, string])[];

  it.each(cases)("renders $0.status/$0.code as %s with closed recovery", (error, visibleState, recovery) => {
    const model = createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      closedError: error,
    }));
    expect(model.visibleState).toBe(visibleState);
    expect(model.error).toMatchObject({ httpStatus: error.status, code: error.code });
    expect(model.actions.map((action) => action.kind)).toContain(recovery);
    expect(model.error?.recoveryLabel.length).toBeGreaterThan(0);
  });

  it("uses a local label for preflight and a server label when the server overrides optimism", () => {
    const local = createAttachmentAuthorityViewModel(input({
      localTransport: { status: "local-rejected", error: { status: 415, code: "attachment_type_unsupported" } },
    }));
    expect(local.authority).toEqual({ kind: "local-transient", label: "LOCAL · preflight" });

    const server = createAttachmentAuthorityViewModel(input({
      localTransport: { status: "local-rejected", error: { status: 415, code: "attachment_type_unsupported" } },
      closedError: { status: 415, code: "type_mismatch" },
    }));
    expect(server.authority).toEqual({ kind: "server-ack", label: "SERVER ACK · authoritative reject" });
    expect(server.error?.code).toBe("type_mismatch");
  });

  it("returns no path, URL, token, raw bytes, base64, blob, or content field", () => {
    const model = createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
      sourceEligibility: "bound-active",
    }));
    const forbidden: string[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (/^(path|url|token|bytes|base64|blob|content)$/iu.test(key)) forbidden.push(key);
        visit(child);
      }
    };
    visit(model);
    expect(forbidden).toEqual([]);
  });
});
