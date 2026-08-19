import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";

declare global {
  interface Window {
    readonly dao?: Readonly<{
      readonly identity: IdentityBridge;
      readonly governance: GovernanceBridge;
    }>;
  }
}

export {};
