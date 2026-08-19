import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";
import type { MessageAuthorityBridge } from "../message-authority/contracts.js";

declare global {
  interface Window {
    readonly dao?: Readonly<{
      readonly identity: IdentityBridge;
      readonly governance: GovernanceBridge;
      readonly messageAuthority: MessageAuthorityBridge;
    }>;
  }
}

export {};
