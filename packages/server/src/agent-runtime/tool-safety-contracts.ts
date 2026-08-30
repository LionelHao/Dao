import type { ToolId } from "@native-im/core";

declare const dispatchPermitBrand: unique symbol;

/**
 * Server-private, non-serializable proof that an exact dispatch claim committed.
 * Only the future Authority claim boundary may construct this nominal value.
 */
export interface DispatchPermit {
  readonly scope: "internal-dispatch";
  readonly dispatchId: string;
  readonly toolCallId: string;
  readonly toolId: ToolId;
  readonly executionVersion: number;
  readonly [dispatchPermitBrand]: "DispatchPermit";
}
