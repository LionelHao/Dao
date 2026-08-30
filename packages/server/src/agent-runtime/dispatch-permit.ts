/**
 * Process-local capability minted by the Authority only after its durable
 * grant/dispatch claim has committed. The runtime value is issuer-local,
 * one-shot, and deliberately cannot cross a serialization boundary.
 */
declare const dispatchPermitBrand: unique symbol;

export type DispatchPermit = Readonly<{ [dispatchPermitBrand]: true }>;

export interface DispatchPermitBinding {
  readonly dispatchId: string;
  readonly grantId: string;
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly executionVersion: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly toolId: "http-json.read" | "repository.git-status" | "sandbox-file.write";
  readonly canonicalParameterSha256: string;
  readonly canonicalizerVersion: string;
  readonly sourceSnapshotId: string;
  readonly accessRevision: number;
  readonly roomLifecycleGeneration: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly principalActorId?: string;
  readonly sessionFamilyId?: string;
  readonly bindingGeneration?: number;
  readonly compensationOfDispatchId?: string;
}

export interface DispatchPermitAuthority {
  grantAfterCommittedClaim<T extends DispatchPermitBinding>(binding: T): Readonly<{
    permit: DispatchPermit;
    permitBinding: T;
  }>;
  consumeCommittedClaim<T extends DispatchPermitBinding>(
    permit: DispatchPermit,
    expected: T,
  ): T | undefined;
}

/**
 * This capability belongs at the Authority construction boundary. Gateways
 * receive only the resulting Authority methods and therefore cannot mint a
 * permit for themselves.
 */
export function createDispatchPermitAuthority(): DispatchPermitAuthority {
  const granted = new WeakMap<object, DispatchPermitBinding>();
  return Object.freeze({
    grantAfterCommittedClaim<T extends DispatchPermitBinding>(binding: T) {
      const permit = Object.freeze({
        toJSON(): never {
          throw new TypeError("DispatchPermit is not serializable");
        },
      });
      granted.set(permit, binding);
      return Object.freeze({ permit: permit as unknown as DispatchPermit, permitBinding: binding });
    },
    consumeCommittedClaim<T extends DispatchPermitBinding>(
      permit: DispatchPermit,
      expected: T,
    ): T | undefined {
      if (typeof permit !== "object" || permit === null) return undefined;
      const binding = granted.get(permit as object);
      if (binding !== expected) return undefined;
      granted.delete(permit as object);
      return expected;
    },
  });
}
