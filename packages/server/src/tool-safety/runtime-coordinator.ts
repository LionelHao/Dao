import { createHash, randomUUID } from "node:crypto";
import type { ExternalToolDescriptor } from "@native-im/core";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import { parseToolParameters } from "../agent-runtime/tool-parameters.js";
import type { ToolSafetyGatewayExecutionInput } from "../agent-runtime/tool-gateway.js";
import type { WorkerToolSafetyAuthority } from "./worker-authority.js";
import { ToolParameterSealer } from "./tool-parameter-sealer.js";

const CONFIRMATION_TTL_MS = 5 * 60_000;
const GRANT_TTL_MS = 60_000;

export type PreparedRuntimeTool = Readonly<{
  toolCallId: string;
  confirmationId?: string;
  grantId?: string;
  safePreview: ReturnType<typeof parseToolParameters>["safePreview"];
  claim: Omit<ToolSafetyGatewayExecutionInput, "grantId" | "signal">;
}>;

function aad(binding: Readonly<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(binding));
}

export function createToolSafetyRuntimeCoordinator(input: Readonly<{
  authority: WorkerToolSafetyAuthority;
  sealer: ToolParameterSealer;
  now: () => number;
}>) {
  return Object.freeze({
    async prepare(preparation: Readonly<{
      executionId: string;
      attemptSeq: number;
      descriptor: ExternalToolDescriptor;
      providerCallId: string;
      argumentsJson: string;
      confirmationContext?: AuthenticatedCommandContext;
    }>): Promise<PreparedRuntimeTool> {
      const now = input.now();
      const parsed = parseToolParameters({
        toolId: preparation.descriptor.id,
        argumentsJson: preparation.argumentsJson,
      });
      const binding = await input.authority.execute({
        type: "tool-safety.read-prepare-binding",
        executionId: preparation.executionId,
        attemptSeq: preparation.attemptSeq,
        toolId: preparation.descriptor.id,
        now,
      });
      if (binding.kind !== "prepare-binding") throw new Error("Tool prepare binding was unavailable");
      const stableCallSuffix = createHash("sha256").update([
        binding.executionId, String(binding.attemptSeq), preparation.providerCallId,
      ].join("\0")).digest("base64url");
      const toolCallId = `tool-call-${stableCallSuffix}`;
      const confirmationId = preparation.descriptor.effect === "side-effect"
        ? `tool-confirmation-${stableCallSuffix}` : undefined;
      const grantId = preparation.descriptor.effect === "read-only"
        ? `tool-grant-${stableCallSuffix}` : undefined;
      if (preparation.descriptor.effect === "side-effect" && preparation.confirmationContext === undefined) {
        throw new Error("Side-effect prepare requires one named Human confirmation principal");
      }
      const confirmationExpiresAt = new Date(now + CONFIRMATION_TTL_MS).toISOString();
      const fullAadBinding = {
        ...binding,
        toolCallId,
        canonicalParameterSha256: parsed.canonicalParameterSha256,
        parameterSchemaVersion: parsed.schemaVersion,
        canonicalizerVersion: parsed.canonicalizerVersion,
        ...(preparation.confirmationContext === undefined ? {} : {
          principalActorId: preparation.confirmationContext.principal.actorId,
          sessionFamilyId: preparation.confirmationContext.sessionFamilyId,
          bindingGeneration: 1,
          expiresAt: confirmationExpiresAt,
        }),
      };
      const canonicalBytes = new TextEncoder().encode(parsed.canonicalParameters);
      const sealedPayload = preparation.descriptor.effect === "side-effect"
        ? input.sealer.seal(canonicalBytes, aad(fullAadBinding), confirmationExpiresAt, now)
        : undefined;
      const result = await input.authority.execute({
        type: "tool-safety.prepare",
        toolCallId,
        invocationId: binding.invocationId,
        executionId: binding.executionId,
        attemptSeq: binding.attemptSeq,
        expectedExecutionVersion: binding.executionVersion,
        toolId: preparation.descriptor.id,
        canonicalParameterSha256: parsed.canonicalParameterSha256,
        parameterSchemaVersion: parsed.schemaVersion,
        canonicalizerVersion: parsed.canonicalizerVersion,
        safePreview: parsed.safePreview as unknown as Readonly<Record<string, unknown>>,
        ...(sealedPayload === undefined ? {} : { sealedPayload }),
        ...(confirmationId === undefined || preparation.confirmationContext === undefined ? {} : {
          confirmation: { confirmationId, context: preparation.confirmationContext,
            bindingGeneration: 1 },
        }),
        ...(grantId === undefined ? {} : {
          grantId, grantExpiresAt: new Date(now + GRANT_TTL_MS).toISOString(),
        }),
        now,
      });
      if (result.kind !== "prepared" || result.claimBinding === undefined) {
        throw new Error("Tool prepare commit result was malformed");
      }
      const claim = {
        toolCallId,
        invocationId: result.claimBinding.invocationId,
        executionId: result.claimBinding.executionId,
        attemptSeq: result.claimBinding.attemptSeq,
        expectedExecutionVersion: result.claimBinding.executionVersion,
        roomId: result.claimBinding.roomId,
        agentId: result.claimBinding.agentId,
        toolId: result.claimBinding.toolId,
        canonicalParameterSha256: result.claimBinding.canonicalParameterSha256,
        canonicalizerVersion: result.claimBinding.canonicalizerVersion,
        sourceSnapshotId: result.claimBinding.sourceSnapshotId,
        expectedAccessRevision: result.claimBinding.accessRevision,
        expectedRoomLifecycleGeneration: result.claimBinding.roomLifecycleGeneration,
        profileId: result.claimBinding.profileId,
        expectedProfileRevision: result.claimBinding.profileRevision,
        assignmentId: result.claimBinding.assignmentId,
        expectedAssignmentRevision: result.claimBinding.assignmentRevision,
        parameters: parsed.parsed as Readonly<Record<string, unknown>>,
        ...(result.claimBinding.principalActorId === undefined ? {} : {
          principalActorId: result.claimBinding.principalActorId,
        }),
        ...(result.claimBinding.sessionFamilyId === undefined ? {} : {
          sessionFamilyId: result.claimBinding.sessionFamilyId,
        }),
        ...(result.claimBinding.bindingGeneration === undefined ? {} : {
          bindingGeneration: result.claimBinding.bindingGeneration,
        }),
      } satisfies Omit<ToolSafetyGatewayExecutionInput, "grantId" | "signal">;
      return Object.freeze({ toolCallId,
        ...(confirmationId === undefined ? {} : { confirmationId }),
        ...(grantId === undefined ? {} : { grantId }),
        safePreview: parsed.safePreview, claim: Object.freeze(claim) });
    },

    async decideConfirmation(command: Readonly<{
      context: AuthenticatedCommandContext;
      confirmationId: string;
      expectedVersion: number;
      decision: "confirm" | "reject";
    }>) {
      const now = input.now();
      const grantId = command.decision === "confirm" ? `tool-grant-${randomUUID()}` : undefined;
      return input.authority.execute({
        type: "tool-safety.confirmation-decide",
        ...command,
        ...(grantId === undefined ? {} : {
          grantId, grantExpiresAt: new Date(now + GRANT_TTL_MS).toISOString(),
        }),
        now,
      });
    },

    async offerHandoff(command: Readonly<{
      context: AuthenticatedCommandContext;
      confirmationId: string;
      expectedVersion: number;
      targetActorId: string;
    }>) {
      const handoffId = `tool-handoff-${createHash("sha256").update([
        command.confirmationId, String(command.expectedVersion), command.targetActorId,
      ].join("\0")).digest("base64url")}`;
      return input.authority.execute({ type: "tool-safety.handoff-offer", ...command,
        handoffId, now: input.now() });
    },

    async acceptHandoff(command: Readonly<{
      context: AuthenticatedCommandContext;
      handoffId: string;
      expectedVersion: number;
    }>) {
      const now = input.now();
      const binding = await input.authority.execute({ type: "tool-safety.handoff-read",
        ...command, now });
      if (binding.kind === "handoff" && binding.state === "accepted" && binding.replayed) {
        return binding;
      }
      if (binding.kind !== "handoff-binding") {
        throw new Error("Tool handoff binding was malformed");
      }
      if (binding.parameterSchemaVersion === "sandbox-file.write.compensation.v1") {
        return input.authority.execute({ type: "tool-safety.handoff-accept", ...command,
          resealedPayload: binding.sealedPayload, now });
      }
      const oldAad = {
        kind: "prepare-binding", invocationId: binding.claimBinding.invocationId,
        executionId: binding.claimBinding.executionId,
        attemptSeq: binding.claimBinding.attemptSeq,
        executionVersion: binding.claimBinding.executionVersion - 1,
        roomId: binding.claimBinding.roomId,
        roomLifecycleGeneration: binding.claimBinding.roomLifecycleGeneration,
        agentId: binding.claimBinding.agentId,
        sourceSnapshotId: binding.claimBinding.sourceSnapshotId,
        accessRevision: binding.claimBinding.accessRevision,
        profileId: binding.claimBinding.profileId,
        profileRevision: binding.claimBinding.profileRevision,
        assignmentId: binding.claimBinding.assignmentId,
        assignmentRevision: binding.claimBinding.assignmentRevision,
        toolId: binding.claimBinding.toolId,
        toolCallId: binding.claimBinding.toolCallId,
        canonicalParameterSha256: binding.claimBinding.canonicalParameterSha256,
        parameterSchemaVersion: binding.parameterSchemaVersion,
        canonicalizerVersion: binding.claimBinding.canonicalizerVersion,
        principalActorId: binding.claimBinding.principalActorId,
        sessionFamilyId: binding.claimBinding.sessionFamilyId,
        bindingGeneration: binding.claimBinding.bindingGeneration,
        expiresAt: binding.sealedPayload.expiresAt,
      };
      const plaintext = input.sealer.open(binding.sealedPayload, aad(oldAad), now);
      try {
        const newAad = { ...oldAad, principalActorId: binding.toPrincipalActorId,
          sessionFamilyId: binding.toSessionFamilyId,
          bindingGeneration: (binding.claimBinding.bindingGeneration ?? 0) + 1 };
        const resealedPayload = input.sealer.seal(plaintext, aad(newAad),
          binding.sealedPayload.expiresAt, now);
        return input.authority.execute({ type: "tool-safety.handoff-accept", ...command,
          resealedPayload, now });
      } finally {
        plaintext.fill(0);
      }
    },

    async proposeCompensation(command: Readonly<{
      context: AuthenticatedCommandContext;
      dispatchId: string;
      expectedVersion: number;
    }>) {
      const now = input.now();
      const suffix = createHash("sha256").update([
        command.context.principal.actorId,
        command.context.idempotencyKey,
        command.dispatchId,
        String(command.expectedVersion),
      ].join("\0")).digest("base64url");
      const canonicalReference = JSON.stringify({
        operation: "compensate",
        originalDispatchId: command.dispatchId,
      });
      const canonicalParameterSha256 = createHash("sha256")
        .update(canonicalReference).digest("hex");
      const expiresAt = new Date(now + CONFIRMATION_TTL_MS).toISOString();
      return input.authority.execute({
        type: "tool-safety.compensation-propose",
        ...command,
        invocationId: `tool-compensation-invocation-${suffix}`,
        executionId: `tool-compensation-execution-${suffix}`,
        toolCallId: `tool-compensation-call-${suffix}`,
        confirmationId: `tool-compensation-confirmation-${suffix}`,
        canonicalParameterSha256,
        sealedReference: {
          ciphertext: createHash("sha256").update(`reference\0${canonicalReference}`).digest("base64url"),
          keyVersion: "dao-compensation-reference.v1",
          expiresAt,
        },
        now,
      });
    },

    async recoverExecution(executionId: string): Promise<Readonly<{
      state: "pending" | "confirmed_active" | "outcome_unknown" | "known_succeeded" |
        "known_failed" | "reviewed" | "none";
      confirmationId?: string;
      confirmationVersion?: number;
      toolCallId?: string;
      grantId?: string;
      claim?: Omit<ToolSafetyGatewayExecutionInput, "grantId" | "signal">;
    }>> {
      const now = input.now();
      const result = await input.authority.execute({
        type: "tool-safety.recover-execution", executionId, now,
      });
      if (result.kind !== "recovery") throw new Error("Tool recovery result was malformed");
      if (result.state !== "confirmed_active") return result;
      if (result.claimBinding === undefined || result.sealedPayload === undefined ||
          result.grantId === undefined || result.toolCallId === undefined ||
          result.parameterSchemaVersion === undefined || result.confirmationId === undefined) {
        throw new Error("Confirmed tool recovery binding was malformed");
      }
      if (result.parameterSchemaVersion === "sandbox-file.write.compensation.v1") {
        if (result.compensationOfDispatchId === undefined) {
          throw new Error("Compensation recovery lineage was malformed");
        }
        return Object.freeze({ state: result.state, confirmationId: result.confirmationId,
          ...(result.confirmationVersion === undefined ? {} : {
            confirmationVersion: result.confirmationVersion,
          }), grantId: result.grantId, toolCallId: result.toolCallId,
          claim: Object.freeze({
            toolCallId: result.toolCallId,
            invocationId: result.claimBinding.invocationId,
            executionId: result.claimBinding.executionId,
            attemptSeq: result.claimBinding.attemptSeq,
            expectedExecutionVersion: result.claimBinding.executionVersion,
            roomId: result.claimBinding.roomId,
            agentId: result.claimBinding.agentId,
            toolId: result.claimBinding.toolId,
            canonicalParameterSha256: result.claimBinding.canonicalParameterSha256,
            canonicalizerVersion: result.claimBinding.canonicalizerVersion,
            sourceSnapshotId: result.claimBinding.sourceSnapshotId,
            expectedAccessRevision: result.claimBinding.accessRevision,
            expectedRoomLifecycleGeneration: result.claimBinding.roomLifecycleGeneration,
            profileId: result.claimBinding.profileId,
            expectedProfileRevision: result.claimBinding.profileRevision,
            assignmentId: result.claimBinding.assignmentId,
            expectedAssignmentRevision: result.claimBinding.assignmentRevision,
            parameters: Object.freeze({}),
            compensationOfDispatchId: result.compensationOfDispatchId,
            principalActorId: result.claimBinding.principalActorId!,
            sessionFamilyId: result.claimBinding.sessionFamilyId!,
            bindingGeneration: result.claimBinding.bindingGeneration!,
          }),
        });
      }
      const fullAadBinding = {
        kind: "prepare-binding",
        invocationId: result.claimBinding.invocationId,
        executionId: result.claimBinding.executionId,
        attemptSeq: result.claimBinding.attemptSeq,
        executionVersion: result.claimBinding.executionVersion - 1,
        roomId: result.claimBinding.roomId,
        roomLifecycleGeneration: result.claimBinding.roomLifecycleGeneration,
        agentId: result.claimBinding.agentId,
        sourceSnapshotId: result.claimBinding.sourceSnapshotId,
        accessRevision: result.claimBinding.accessRevision,
        profileId: result.claimBinding.profileId,
        profileRevision: result.claimBinding.profileRevision,
        assignmentId: result.claimBinding.assignmentId,
        assignmentRevision: result.claimBinding.assignmentRevision,
        toolId: result.claimBinding.toolId,
        toolCallId: result.toolCallId,
        canonicalParameterSha256: result.claimBinding.canonicalParameterSha256,
        parameterSchemaVersion: result.parameterSchemaVersion,
        canonicalizerVersion: result.claimBinding.canonicalizerVersion,
        principalActorId: result.claimBinding.principalActorId,
        sessionFamilyId: result.claimBinding.sessionFamilyId,
        bindingGeneration: result.claimBinding.bindingGeneration,
        expiresAt: result.sealedPayload.expiresAt,
      };
      const plaintext = input.sealer.open(result.sealedPayload, aad(fullAadBinding), now);
      try {
        const parsed = parseToolParameters({ toolId: result.claimBinding.toolId,
          argumentsJson: new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
          expectedSchemaVersion: result.parameterSchemaVersion,
          canonicalizerVersion: result.claimBinding.canonicalizerVersion });
        if (parsed.canonicalParameterSha256 !== result.claimBinding.canonicalParameterSha256) {
          throw new Error("Recovered tool parameter hash changed");
        }
        return Object.freeze({ state: result.state, confirmationId: result.confirmationId,
          ...(result.confirmationVersion === undefined ? {} : {
            confirmationVersion: result.confirmationVersion,
          }), grantId: result.grantId,
          toolCallId: result.toolCallId,
          claim: Object.freeze({
            toolCallId: result.toolCallId,
            invocationId: result.claimBinding.invocationId,
            executionId: result.claimBinding.executionId,
            attemptSeq: result.claimBinding.attemptSeq,
            expectedExecutionVersion: result.claimBinding.executionVersion,
            roomId: result.claimBinding.roomId,
            agentId: result.claimBinding.agentId,
            toolId: result.claimBinding.toolId,
            canonicalParameterSha256: result.claimBinding.canonicalParameterSha256,
            canonicalizerVersion: result.claimBinding.canonicalizerVersion,
            sourceSnapshotId: result.claimBinding.sourceSnapshotId,
            expectedAccessRevision: result.claimBinding.accessRevision,
            expectedRoomLifecycleGeneration: result.claimBinding.roomLifecycleGeneration,
            profileId: result.claimBinding.profileId,
            expectedProfileRevision: result.claimBinding.profileRevision,
            assignmentId: result.claimBinding.assignmentId,
            expectedAssignmentRevision: result.claimBinding.assignmentRevision,
            parameters: parsed.parsed as Readonly<Record<string, unknown>>,
            principalActorId: result.claimBinding.principalActorId!,
            sessionFamilyId: result.claimBinding.sessionFamilyId!,
            bindingGeneration: result.claimBinding.bindingGeneration!,
          }),
        });
      } finally {
        plaintext.fill(0);
      }
    },
  });
}
