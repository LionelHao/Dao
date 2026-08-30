/**
 * Process-local capability issued only after a durable dispatch claim commits.
 * The brand is deliberately module-private, while the runtime value is held in
 * an issuer-local WeakMap and cannot survive JSON or structured cloning.
 */
declare const dispatchPermitBrand: unique symbol;

export type DispatchPermit = Readonly<{ [dispatchPermitBrand]: true }>;

export interface DispatchPermitBinding {
  readonly dispatchId: string;
  readonly toolId: "http-json.read" | "repository.git-status" | "sandbox-file.write";
}

export interface DispatchPermitIssuer {
  issue<T extends DispatchPermitBinding>(binding: T): DispatchPermit;
  consume<T extends DispatchPermitBinding>(permit: DispatchPermit, expected: T): T | undefined;
}

export function createDispatchPermitIssuer(): DispatchPermitIssuer {
  const issued = new WeakMap<object, DispatchPermitBinding>();
  return Object.freeze({
    issue<T extends DispatchPermitBinding>(binding: T): DispatchPermit {
      const permit = Object.freeze({
        toJSON(): never {
          throw new TypeError("DispatchPermit is not serializable");
        },
      });
      issued.set(permit, binding);
      return permit as unknown as DispatchPermit;
    },
    consume<T extends DispatchPermitBinding>(permit: DispatchPermit, expected: T): T | undefined {
      if (typeof permit !== "object" || permit === null) return undefined;
      const binding = issued.get(permit as object);
      if (binding !== expected) return undefined;
      issued.delete(permit as object);
      return expected;
    },
  });
}
