import type { DispatchPermit } from "./dispatch-permit.js";

// @ts-expect-error DispatchPermit is server-private and absent from the package root.
import type { DispatchPermit as PublicDispatchPermit } from "../index.js";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

type JsonLikePermit = Readonly<{
  dispatchId: string;
  toolId: "sandbox-file.write";
}>;

export type JsonCannotForgePermit = Assert<Not<IsAssignable<JsonLikePermit, DispatchPermit>>>;
export type PackageRootPermitMustStayUnavailable = PublicDispatchPermit;
