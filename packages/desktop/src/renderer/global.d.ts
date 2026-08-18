import type { IdentityBridge } from "../identity/contracts.js";

declare global {
  interface Window {
    readonly dao?: Readonly<{
      readonly identity: IdentityBridge;
    }>;
  }
}

export {};
