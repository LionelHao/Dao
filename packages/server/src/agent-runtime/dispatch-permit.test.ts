import { describe, expect, it } from "vitest";
import { createDispatchPermitIssuer } from "./dispatch-permit.js";

describe("DispatchPermit", () => {
  it("is opaque, non-serializable, issuer-local and consumable exactly once", () => {
    const issuer = createDispatchPermitIssuer();
    const otherIssuer = createDispatchPermitIssuer();
    const claim = Object.freeze({ dispatchId: "dispatch-1", toolId: "sandbox-file.write" as const });
    const permit = issuer.issue(claim);

    expect(() => JSON.stringify(permit)).toThrow(TypeError);
    expect(() => structuredClone(permit)).toThrow();
    expect(otherIssuer.consume(permit, claim)).toBeUndefined();
    expect(issuer.consume(permit, claim)).toEqual(claim);
    expect(issuer.consume(permit, claim)).toBeUndefined();
    expect(issuer.consume({} as typeof permit, claim)).toBeUndefined();
  });

  it("does not consume a permit through a changed dispatch binding", () => {
    const issuer = createDispatchPermitIssuer();
    const claim = Object.freeze({ dispatchId: "dispatch-1", toolId: "sandbox-file.write" as const });
    const permit = issuer.issue(claim);

    expect(issuer.consume(permit, { ...claim, dispatchId: "dispatch-2" })).toBeUndefined();
    expect(issuer.consume(permit, claim)).toEqual(claim);
  });
});
