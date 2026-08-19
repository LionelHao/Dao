import { describe, expect, it } from "vitest";
import {
  AUTHORITY_PARTICIPANT_FEATURES,
  isAuthorityParticipantEnvelope,
  isAuthorityTransactionView,
  isFeatureEnablementManifest,
  isParticipantRegistration,
  mintAuthorityTransactionView,
} from "./private-participant-contracts.js";

describe("private participant contract guards", () => {
  const manifest = Object.fromEntries(
    AUTHORITY_PARTICIPANT_FEATURES.map((feature) => [feature, false]),
  );

  it("accepts only an exact, complete feature enablement manifest", () => {
    expect(isFeatureEnablementManifest(manifest)).toBe(true);
    expect(isFeatureEnablementManifest({ ...manifest, unknownFeature: false })).toBe(false);
    const incomplete = Object.fromEntries(
      Object.entries(manifest).filter(([feature]) => feature !== "offline-lease-invalidation"),
    );
    expect(isFeatureEnablementManifest(incomplete)).toBe(false);
  });

  it("parses exact-key registrations and rejects production no-op substitutes", () => {
    const disabled = {
      registrationId: "ft03-message-gate",
      feature: "archived-message-gate",
      version: 1,
      enabled: false,
    };
    expect(isParticipantRegistration(disabled)).toBe(true);
    expect(isParticipantRegistration({ ...disabled, participant: { blockForArchive: () => [] } }))
      .toBe(false);
    expect(isParticipantRegistration({ ...disabled, rawSql: "SELECT 1" })).toBe(false);
    expect(isParticipantRegistration({ ...disabled, version: 2 })).toBe(false);
    expect(isParticipantRegistration({ ...disabled, feature: "plugin-feature" })).toBe(false);
  });

  it("rejects malformed or sensitive result envelopes", () => {
    const valid = {
      ok: true,
      result: {
        roomId: "room-1",
        archiveGeneration: 1,
        gateGeneration: 1,
        blockedMutationKinds: ["message", "message_intent"],
      },
    };
    expect(isAuthorityParticipantEnvelope("archived-message-gate", valid, "room-1")).toBe(true);
    expect(isAuthorityParticipantEnvelope(
      "archived-message-gate",
      { ...valid, result: { ...valid.result, stack: "private stack" } },
      "room-1",
    )).toBe(false);
    expect(isAuthorityParticipantEnvelope(
      "archived-message-gate",
      { ...valid, result: { ...valid.result, roomId: "room-2" } },
      "room-1",
    )).toBe(false);
  });

  it("mints a non-enumerable transaction capability that JSON cannot reconstruct", () => {
    const tx = mintAuthorityTransactionView("room-1", "tx-1");
    expect(isAuthorityTransactionView(tx)).toBe(true);
    expect(JSON.stringify(tx)).toBe("{}");
    expect(isAuthorityTransactionView(JSON.parse(JSON.stringify(tx)))).toBe(false);
    expect(isAuthorityTransactionView({ roomId: "room-1", transactionId: "tx-1" })).toBe(false);
  });
});
