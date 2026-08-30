import { describe, expect, it } from "vitest";
import { createDispatchPermitAuthority } from "./dispatch-permit.js";

const binding = (dispatchId: string) => Object.freeze({
  dispatchId,
  grantId: "grant-1",
  toolCallId: "tool-call-1",
  invocationId: "invocation-1",
  executionId: "execution-1",
  attemptSeq: 1,
  executionVersion: 1,
  roomId: "room-1",
  agentId: "agent-1",
  toolId: "sandbox-file.write" as const,
  canonicalParameterSha256: "a".repeat(64),
  canonicalizerVersion: "rfc8785-ft10-v1",
  sourceSnapshotId: "snapshot-1",
  accessRevision: 1,
  roomLifecycleGeneration: 1,
  profileId: "profile-1",
  profileRevision: 1,
  assignmentId: "assignment-1",
  assignmentRevision: 1,
  principalActorId: "human-1",
  sessionFamilyId: "family-1",
  bindingGeneration: 1,
});

describe("DispatchPermit", () => {
  it("is opaque, non-serializable, issuer-local and consumable exactly once", () => {
    const authority = createDispatchPermitAuthority();
    const otherAuthority = createDispatchPermitAuthority();
    const claim = binding("dispatch-1");
    const { permit, permitBinding } = authority.grantAfterCommittedClaim(claim);

    expect(() => JSON.stringify(permit)).toThrow(TypeError);
    expect(() => structuredClone(permit)).toThrow();
    expect(otherAuthority.consumeCommittedClaim(permit, permitBinding)).toBeUndefined();
    expect(authority.consumeCommittedClaim(permit, permitBinding)).toEqual(claim);
    expect(authority.consumeCommittedClaim(permit, permitBinding)).toBeUndefined();
    expect(authority.consumeCommittedClaim({} as typeof permit, permitBinding)).toBeUndefined();
  });

  it("does not consume a permit through a changed dispatch binding", () => {
    const authority = createDispatchPermitAuthority();
    const claim = binding("dispatch-1");
    const { permit, permitBinding } = authority.grantAfterCommittedClaim(claim);

    expect(authority.consumeCommittedClaim(permit, binding("dispatch-2"))).toBeUndefined();
    expect(authority.consumeCommittedClaim(permit, permitBinding)).toEqual(claim);
  });
});
