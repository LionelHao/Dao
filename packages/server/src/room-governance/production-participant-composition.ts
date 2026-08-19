import type { BallDeadlinePolicy } from "../ball-runtime/ball-authority-protocol.js";
import { createBusinessTimerSuspensionProductionRegistration } from "../business-timers/business-timer-suspension-participant.js";
import { roomCacheInvalidationRegistration } from "../access/room-cache-invalidation-port.js";
import { createOfflineLeaseInvalidationRegistration } from "../access/offline-lease-invalidation-port.js";
import { runtimeArchiveFenceParticipantRegistration } from "../agent-runtime/runtime-archive-fence-participant.js";
import { archivedMessageGateRegistration } from "../message-authority/archived-message-gate.js";
import { createDepartureResponsibilityRegistration } from "../project-loop/departure-responsibility-port.js";
import { assignmentSecurityReductionParticipantRegistration } from "../room-assignment/assignment-security-reduction-participant.js";
import { archiveToolSafetyParticipantRegistration } from "../tool-safety/archive-tool-safety-participant.js";
import { pendingConfirmationDepartureContributorRegistration } from "../tool-safety/pending-confirmation-departure-contributor.js";
import {
  AUTHORITY_PARTICIPANT_FEATURES,
  type FeatureEnablementManifest,
} from "./private-participant-contracts.js";
import { lifecycleRepairDescriptorRegistration } from "./lifecycle-repair-descriptor.js";
import { assertSharedAuthorityParticipantComposition } from "./private-participant-registry.js";

export function createProductionSharedAuthorityParticipantComposition(options: Readonly<{
  maxOfflineReadLeaseMs: number;
  ballPolicy: BallDeadlinePolicy;
}>): Readonly<{
  manifest: FeatureEnablementManifest;
  registrations: readonly unknown[];
}> {
  const pendingConfirmation = pendingConfirmationDepartureContributorRegistration;
  const manifest = Object.freeze(Object.fromEntries(
    AUTHORITY_PARTICIPANT_FEATURES.map((feature) => [feature, true]),
  )) as FeatureEnablementManifest;
  const registrations = Object.freeze([
    createDepartureResponsibilityRegistration({
      pendingConfirmation: {
        enabled: true,
        registrations: [pendingConfirmation],
      },
    }),
    pendingConfirmation,
    archivedMessageGateRegistration,
    createBusinessTimerSuspensionProductionRegistration(options.ballPolicy),
    archiveToolSafetyParticipantRegistration,
    runtimeArchiveFenceParticipantRegistration,
    assignmentSecurityReductionParticipantRegistration,
    lifecycleRepairDescriptorRegistration,
    roomCacheInvalidationRegistration,
    createOfflineLeaseInvalidationRegistration({
      maxOfflineReadLeaseMs: options.maxOfflineReadLeaseMs,
    }),
  ]);
  assertSharedAuthorityParticipantComposition(manifest, registrations);
  return Object.freeze({ manifest, registrations });
}
