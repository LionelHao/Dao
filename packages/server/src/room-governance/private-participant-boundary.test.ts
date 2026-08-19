import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PRIVATE_MARKERS = [
  "AuthorityTransactionView",
  "mintDatabaseAuthorityTransactionView",
  "releaseDatabaseAuthorityTransactionView",
  "useAuthorityTransactionDatabase",
  "withDatabaseAuthorityTransactionView",
  "ParticipantRegistration",
  "DepartureResponsibilityContributor",
  "PendingConfirmationDepartureContributor",
  "ArchivedMessageGate",
  "BusinessTimerSuspensionParticipant",
  "ArchiveSettlementParticipant",
  "RuntimeArchiveFenceParticipant",
  "AssignmentSecurityReductionParticipant",
  "LifecycleRepairDescriptor",
  "RoomCacheInvalidationPort",
  "OfflineLeaseInvalidationPort",
] as const;

describe("shared authority participant package boundary", () => {
  it("keeps transaction capabilities and participants off the server package root", async () => {
    const publicApi: Record<string, unknown> = await import("../index.js");
    for (const marker of PRIVATE_MARKERS) {
      expect(publicApi).not.toHaveProperty(marker);
    }
    const serverRoot = await readFile(
      join(process.cwd(), "packages/server/src/index.ts"),
      "utf8",
    );
    expect(serverRoot).not.toContain("private-participant-contracts");
    expect(serverRoot).not.toContain("private-participant-registry");
  });

  it("keeps the private spine out of Core, protocol, WebSocket, preload, and renderer", async () => {
    const paths = [
      "packages/core/src/index.ts",
      "packages/server/src/protocol.ts",
      "packages/server/src/websocket.ts",
      "packages/desktop/src/preload.ts",
      "packages/desktop/src/renderer/app.ts",
    ];
    for (const path of paths) {
      const source = await readFile(join(process.cwd(), path), "utf8");
      expect(source, path).not.toContain("private-participant-contracts");
      expect(source, path).not.toContain("private-participant-registry");
      expect(source, path).not.toContain("AuthorityTransactionView");
      expect(source, path).not.toContain("ParticipantRegistration");
    }
  });
});
