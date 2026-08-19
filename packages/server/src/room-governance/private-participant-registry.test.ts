import { describe, expect, it } from "vitest";
import {
  AUTHORITY_PARTICIPANT_FEATURES,
  mintAuthorityTransactionView,
  type AuthorityParticipantFeature,
  type FeatureEnablementManifest,
  type ParticipantRegistration,
} from "./private-participant-contracts.js";
import {
  AuthorityParticipantUnavailableError,
  assertAuthorityParticipantRegistry,
  assertSharedAuthorityParticipantComposition,
  invokeAccessInvalidationPort,
  invokeAuthorityParticipant,
} from "./private-participant-registry.js";

function manifestWith(
  feature: AuthorityParticipantFeature,
  enabled: boolean,
): FeatureEnablementManifest {
  return Object.fromEntries(
    AUTHORITY_PARTICIPANT_FEATURES.map((candidate) => [candidate, candidate === feature && enabled]),
  ) as unknown as FeatureEnablementManifest;
}

function enabledMessageGate(
  resultRoomId = "room-1",
): ParticipantRegistration<{ blockForArchive(): unknown }> {
  return {
    registrationId: "ft03-message-gate",
    feature: "archived-message-gate",
    version: 1,
    enabled: true,
    participant: {
      blockForArchive: () => ({
        ok: true,
        result: {
          roomId: resultRoomId,
          archiveGeneration: 1,
          gateGeneration: 1,
          blockedMutationKinds: ["message", "message_intent"],
        },
      }),
    },
  };
}

function expectClosed503(
  action: () => unknown,
  reason: string,
  dependency: AuthorityParticipantFeature = "archived-message-gate",
): void {
  try {
    action();
    throw new Error("expected a closed 503");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorityParticipantUnavailableError);
    const unavailable = error as AuthorityParticipantUnavailableError;
    expect(unavailable.safeError).toEqual({
      httpStatus: 503,
      code: "dependency_unavailable",
      dependency,
      reason,
      retryable: true,
    });
    expect(unavailable.safeError).not.toHaveProperty("stack");
    expect(unavailable.safeError).not.toHaveProperty("sql");
  }
}

describe("private participant registry", () => {
  it("requires a registration for every enabled fixed feature", () => {
    for (const feature of AUTHORITY_PARTICIPANT_FEATURES) {
      expectClosed503(
        () => assertSharedAuthorityParticipantComposition(manifestWith(feature, true), []),
        "missing_registration",
        feature,
      );
    }
  });

  it("fails startup for enabled-missing, duplicate IDs, version mismatch, and manifest mismatch", () => {
    expectClosed503(
      () => assertAuthorityParticipantRegistry(manifestWith("archived-message-gate", true), []),
      "missing_registration",
    );
    expectClosed503(
      () => assertAuthorityParticipantRegistry(
        manifestWith("archived-message-gate", true),
        [enabledMessageGate(), { ...enabledMessageGate(), feature: "runtime-archive-fence" }],
      ),
      "duplicate_registration_id",
    );
    expectClosed503(
      () => assertAuthorityParticipantRegistry(
        manifestWith("archived-message-gate", true),
        [{ ...enabledMessageGate(), version: 2 } as never],
      ),
      "version_mismatch",
    );
    expectClosed503(
      () => assertAuthorityParticipantRegistry(
        manifestWith("archived-message-gate", false),
        [enabledMessageGate()],
      ),
      "manifest_mismatch",
    );
  });

  it("allows a disabled feature only without a participant substitute", () => {
    expect(() => assertAuthorityParticipantRegistry(
      manifestWith("archived-message-gate", false),
      [{
        registrationId: "ft03-message-gate-disabled",
        feature: "archived-message-gate",
        version: 1,
        enabled: false,
      }],
    )).not.toThrow();
  });

  it("fails the command guard before participant work when registration is unavailable", () => {
    let businessWrites = 0;
    const tx = mintAuthorityTransactionView("room-1", "tx-1");
    expectClosed503(
      () => invokeAuthorityParticipant({
        feature: "archived-message-gate",
        manifest: manifestWith("archived-message-gate", true),
        registrations: [],
        tx,
        roomId: "room-1",
        invoke: () => {
          businessWrites += 1;
          return undefined;
        },
      }),
      "missing_registration",
    );
    expect(businessWrites).toBe(0);
  });

  it("maps thrown, malformed, and cross-Room participant results to closed 503", () => {
    const tx = mintAuthorityTransactionView("room-1", "tx-1");
    const base = {
      feature: "archived-message-gate" as const,
      manifest: manifestWith("archived-message-gate", true),
      tx,
      roomId: "room-1",
    };
    expectClosed503(
      () => invokeAuthorityParticipant({
        ...base,
        registrations: [enabledMessageGate()],
        invoke: () => { throw new Error("SQL SELECT token=secret\nprivate stack"); },
      }),
      "participant_threw",
    );
    expectClosed503(
      () => invokeAuthorityParticipant({
        ...base,
        registrations: [enabledMessageGate()],
        invoke: () => ({ ok: true, result: [] }),
      }),
      "malformed_result",
    );
    expectClosed503(
      () => invokeAuthorityParticipant({
        ...base,
        registrations: [enabledMessageGate("room-2")],
        invoke: (participant) => participant.blockForArchive(),
      }),
      "cross_room_result",
    );
  });

  it("throws before a malformed participant transaction can commit", () => {
    let durableBusinessWrites = 0;
    const tx = mintAuthorityTransactionView("room-1", "tx-rollback-proof");
    const runExistingTransaction = (operation: (recordWrite: () => void) => void): void => {
      let pendingBusinessWrites = 0;
      try {
        operation(() => { pendingBusinessWrites += 1; });
        durableBusinessWrites += pendingBusinessWrites;
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorityParticipantUnavailableError);
      }
    };

    runExistingTransaction((recordWrite) => {
      invokeAuthorityParticipant({
        feature: "archived-message-gate",
        manifest: manifestWith("archived-message-gate", true),
        registrations: [enabledMessageGate()],
        tx,
        roomId: "room-1",
        invoke: () => {
          recordWrite();
          return { ok: true, result: { roomId: "room-1", rawMessage: "private" } };
        },
      });
    });
    expect(durableBusinessWrites).toBe(0);
  });

  it("keeps the access-port composition gate separate and rejects cross-Room output", () => {
    const feature = "room-cache-invalidation" as const;
    const registrations = [{
      registrationId: "ft13-room-cache-invalidation",
      feature,
      version: 1,
      enabled: true,
      participant: {
        invalidateRoomCacheInTransaction: () => ({
          ok: true,
          result: {
            roomId: "room-2",
            lifecycleGeneration: 1,
            invalidationIntentId: "intent-1",
            accessRevision: 1,
          },
        }),
      },
    }];
    const tx = mintAuthorityTransactionView("room-1", "tx-access");
    expectClosed503(
      () => invokeAccessInvalidationPort({
        feature,
        manifest: manifestWith(feature, true),
        registrations,
        tx,
        roomId: "room-1",
        invoke: (port) => port.invalidateRoomCacheInTransaction(
          tx,
          { roomId: "room-1", lifecycleGeneration: 1, reason: "room_archived" },
        ),
      }),
      "cross_room_result",
      feature,
    );
  });
});
