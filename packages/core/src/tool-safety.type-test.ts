import type {
  ExternalToolDescriptor,
  InternalToolSeamDescriptor,
  PublicToolSafetyProjection,
  ToolConfirmationRecord,
  ToolDispatchRecord,
  ToolGrantRecord,
  ToolId,
  ToolReviewRecord,
  ToolCallBinding,
} from "./tool-safety.js";

const physicalTool: ToolId = "sandbox-file.write";
// @ts-expect-error Internal source seams are not physical adapters.
const sourceAsPhysical: ToolId = "room-memory.read";
// @ts-expect-error Project operations are not physical adapters.
const projectAsPhysical: ToolId = "project.command";

const readDescriptor: ExternalToolDescriptor = {
  scope: "external", id: "repository.git-status", effect: "read-only",
};
const compensatedRead: ExternalToolDescriptor = {
  scope: "external", id: "repository.git-status", effect: "read-only",
  // @ts-expect-error Read descriptors cannot advertise compensation.
  reversibility: "compensatable",
};
// @ts-expect-error A side effect must state its reversibility.
const incompleteWrite: ExternalToolDescriptor = {
  scope: "external", id: "sandbox-file.write", effect: "side-effect",
};

const sourceDescriptor: InternalToolSeamDescriptor = {
  scope: "internal", id: "room-memory.read", kind: "source-read",
};
// @ts-expect-error Public/external descriptors cannot receive an internal source descriptor.
const leakedSource: ExternalToolDescriptor = sourceDescriptor;

const binding: ToolCallBinding = {
  scope: "internal", toolCallId: "tool-call-1", invocationId: "invocation-1",
  executionId: "execution-1", attemptSeq: 1, executionVersion: 2, roomId: "room-1",
  agentId: "agent-1", toolId: "sandbox-file.write", canonicalParameterSha256: "a".repeat(64),
  parameterSchemaVersion: "sandbox-file.write.parameters.v1",
  canonicalizerVersion: "rfc8785-profile.v1", sourceSnapshotId: "snapshot-1",
  profileRevision: 3, assignmentRevision: 4, accessRevision: 5,
};
const missingSourceBinding = {
  ...binding,
  sourceSnapshotId: undefined,
};
// @ts-expect-error Binding cannot omit the exact source snapshot identity.
const invalidMissingSourceBinding: ToolCallBinding = missingSourceBinding;

const pending: ToolConfirmationRecord = {
  scope: "internal", confirmationId: "confirmation-1", toolCallId: "tool-call-1",
  state: "pending", version: 1, bindingGeneration: 1,
};
// @ts-expect-error Pending confirmation has no confirmer.
const pendingWithConfirmer: ToolConfirmationRecord = { ...pending, decidedByActorId: "human-1" };

const active: ToolGrantRecord = {
  scope: "internal", grantId: "grant-1", toolCallId: "tool-call-1", state: "active",
  version: 1, expiresAt: "2026-08-30T00:01:00.000Z",
};
// @ts-expect-error An active grant has not been claimed by a dispatch.
const activeWithDispatch: ToolGrantRecord = { ...active, dispatchId: "dispatch-1" };

const unknown: ToolDispatchRecord = {
  scope: "internal", dispatchId: "dispatch-1", grantId: "grant-1", toolCallId: "tool-call-1",
  state: "outcome_unknown", version: 1, occurredAt: "2026-08-30T00:00:02.000Z",
  reason: "claim_committed",
};
// @ts-expect-error A reviewed dispatch must reference a separate review record.
const incompleteReviewed: ToolDispatchRecord = { ...unknown, state: "reviewed" };

const review: ToolReviewRecord = {
  scope: "internal", reviewId: "review-1", dispatchId: "dispatch-1", version: 1,
  resolution: "known_failed", reviewedByActorId: "human-1",
  reviewedAt: "2026-08-30T00:00:03.000Z", evidenceSummarySha256: "a".repeat(64),
};
const projection: PublicToolSafetyProjection = {
  scope: "public", toolCallId: "tool-call-1", state: "outcome_unknown", version: 1,
  safePreview: { schemaVersion: "tool-safe-preview.v1", target: "Configured target",
    summary: "A bounded action", impact: "No raw parameters are shown",
    reversibility: "unknown" },
};
// @ts-expect-error Public projections cannot be consumed as internal dispatch authority.
const projectionAsDispatch: ToolDispatchRecord = projection;

void physicalTool;
void sourceAsPhysical;
void projectAsPhysical;
void readDescriptor;
void compensatedRead;
void incompleteWrite;
void leakedSource;
void binding;
void invalidMissingSourceBinding;
void pendingWithConfirmer;
void activeWithDispatch;
void incompleteReviewed;
void review;
void projectionAsDispatch;
