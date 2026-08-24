import { describe, expect, it } from "vitest";
import { isRouteAuthorityOperation } from "./route-authority-protocol.js";

describe("route authority private protocol", () => {
  it("requires server-derived provider readiness on route claims", () => {
    expect(isRouteAuthorityOperation({
      type: "route.claim",
      sourceMessageId: "message-1",
      agentProviderReady: true,
      now: 1,
    })).toBe(true);
    expect(isRouteAuthorityOperation({
      type: "route.claim",
      sourceMessageId: "message-1",
      now: 1,
    })).toBe(false);
    expect(isRouteAuthorityOperation({
      type: "route.claim",
      sourceMessageId: "message-1",
      agentProviderReady: "true",
      now: 1,
    })).toBe(false);
  });

  it("keeps handoff claim and recovery operations exact and server-private", () => {
    const claim = {
      type: "route.handoff.claim",
      roomId: "room-1",
      intentId: "intent-1",
      providerReady: false,
      now: 2,
    } as const;
    expect(isRouteAuthorityOperation(claim)).toBe(true);
    expect(isRouteAuthorityOperation({ ...claim, originToken: "client" })).toBe(false);
    expect(isRouteAuthorityOperation({ ...claim, providerReady: 1 })).toBe(false);
    expect(isRouteAuthorityOperation({
      type: "route.handoff.recover",
      now: 3,
    })).toBe(true);
    expect(isRouteAuthorityOperation({
      type: "route.handoff.recover",
      roomId: "room-1",
      now: 3,
    })).toBe(false);
  });
});
