import { describe, expect, it, vi } from "vitest";

import { createElectronAttachmentRuntimeHost } from "./electron-runtime-host.js";

function runtime(label: string) {
  return {
    label,
    controller: {} as never,
    invalidateAuthorizedState: vi.fn(),
    close: vi.fn(),
  };
}

describe("Electron Attachment Authority lifecycle host", () => {
  it("replaces closed authority on identity invalidation and Room lifecycle boundaries", () => {
    const created = [runtime("one"), runtime("two"), runtime("three"), runtime("four")];
    const createRuntime = vi.fn(() => created.shift()!);
    const host = createElectronAttachmentRuntimeHost({ createRuntime });

    expect(host.start().label).toBe("one");
    host.observeGovernanceState({ roomId: "room-1", state: {
      status: "ready", projection: { lifecycle: "active" },
    } } as never);
    expect(createRuntime).toHaveBeenCalledOnce();

    host.observeGovernanceState({ roomId: "room-1", state: {
      status: "ready", projection: { lifecycle: "archived" },
    } } as never);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect((host.current() as typeof created[number] & { label: string }).label).toBe("two");

    host.invalidateIdentity();
    expect(createRuntime).toHaveBeenCalledTimes(3);
    expect((host.current() as { label: string }).label).toBe("three");

    host.observeGovernanceState({ roomId: "room-1", state: {
      status: "locked", connection: { status: "revoked", scope: "room", purgeCompleted: true },
    } } as never);
    expect(createRuntime).toHaveBeenCalledTimes(4);
    expect((host.current() as { label: string }).label).toBe("four");
    host.close();

    expect(created).toEqual([]);
    expect(createRuntime).toHaveBeenCalledTimes(4);
  });

  it("publishes identity revocation before close, deduplicates Room states, and never restarts after close", () => {
    const runtimes = [runtime("one"), runtime("two"), runtime("three")];
    const host = createElectronAttachmentRuntimeHost({ createRuntime: () => runtimes.shift()! });
    const one = host.start() as ReturnType<typeof runtime>;
    host.invalidateIdentity();
    expect(one.invalidateAuthorizedState).toHaveBeenCalledWith("session_revoked");
    expect(one.close).toHaveBeenCalledOnce();

    const two = host.current() as ReturnType<typeof runtime>;
    const revoked = { roomId: "room-2", state: { status: "locked",
      connection: { status: "revoked", scope: "room", purgeCompleted: true } } } as never;
    host.observeGovernanceState(revoked);
    host.observeGovernanceState(revoked);
    expect(two.close).toHaveBeenCalledOnce();
    const three = host.current() as ReturnType<typeof runtime>;
    host.close();
    host.invalidateIdentity();
    expect(three.close).toHaveBeenCalledOnce();
    expect(host.current()).toBeUndefined();
  });
});
