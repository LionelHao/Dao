import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";
import type { MessageAuthorityBridge } from "../message-authority/contracts.js";
import type { AttachmentAuthorityBridge } from "../attachment-authority/contracts.js";
import type { MemoryAuthorityBridge } from "../memory-authority/contracts.js";
import type { AgentSettingsBridge } from "../agent-profile-routing/contracts.js";
import type { InvocationBridge } from "../invocation-runtime/contracts.js";
import type { ProjectLoopBridge } from "../project-loop/contracts.js";

declare global {
  interface Window {
    readonly dao?: Readonly<{
      readonly identity: IdentityBridge;
      readonly governance: GovernanceBridge;
      readonly messageAuthority: MessageAuthorityBridge;
      readonly attachmentAuthority: AttachmentAuthorityBridge;
      readonly memoryAuthority: MemoryAuthorityBridge;
      readonly agentSettings: AgentSettingsBridge;
      readonly invocation: InvocationBridge;
      readonly projectLoop: ProjectLoopBridge;
    }>;
  }
}

export {};
