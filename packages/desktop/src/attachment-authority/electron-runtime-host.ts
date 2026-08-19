import type { GovernanceStateEnvelope } from "../governance/contracts.js";
import type { DesktopAttachmentAuthorityRuntime } from "./production-runtime.js";

export interface ElectronAttachmentRuntimeHost<
  TRuntime extends DesktopAttachmentAuthorityRuntime = DesktopAttachmentAuthorityRuntime,
> {
  start(): TRuntime;
  current(): TRuntime | undefined;
  invalidateIdentity(): void;
  observeGovernanceState(envelope: GovernanceStateEnvelope): void;
  close(): void;
}

export function createElectronAttachmentRuntimeHost<
  TRuntime extends DesktopAttachmentAuthorityRuntime,
>(options: {
  readonly createRuntime: () => TRuntime;
  readonly onReplacementError?: (error: unknown) => void;
}): ElectronAttachmentRuntimeHost<TRuntime> {
  const roomLifecycles = new Map<string, "active" | "archived" | "revoked">();
  let runtime: TRuntime | undefined;
  let closed = false;

  function create(): TRuntime {
    if (closed) throw new Error("Electron Attachment Authority host is closed");
    const next = options.createRuntime();
    runtime = next;
    return next;
  }

  function replace(reason: "identity" | "room"): void {
    if (closed) return;
    const prior = runtime;
    runtime = undefined;
    if (reason === "identity") prior?.invalidateAuthorizedState("session_revoked");
    prior?.close();
    try {
      create();
    } catch (error) {
      options.onReplacementError?.(error);
    }
  }

  const host: ElectronAttachmentRuntimeHost<TRuntime> = {
    start() {
      return runtime ?? create();
    },
    current() {
      return runtime;
    },
    invalidateIdentity() {
      replace("identity");
    },
    observeGovernanceState(envelope) {
      if (closed) return;
      if (envelope.state.status === "ready") {
        const next = envelope.state.projection.lifecycle;
        const previous = roomLifecycles.get(envelope.roomId);
        roomLifecycles.set(envelope.roomId, next);
        if ((previous === undefined && next === "archived") ||
          (previous !== undefined && previous !== next)) {
          replace("room");
        }
        return;
      }
      if (envelope.state.connection.status === "revoked" &&
        roomLifecycles.get(envelope.roomId) !== "revoked") {
        roomLifecycles.set(envelope.roomId, "revoked");
        replace("room");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      roomLifecycles.clear();
      const prior = runtime;
      runtime = undefined;
      prior?.close();
    },
  };
  return Object.freeze(host);
}
