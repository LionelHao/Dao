import type { AgentRuntimeProviderInput } from "./contracts.js";

interface RouterProviderInput {
  readonly purpose: "route_decision";
  readonly roomId: string;
  readonly messageId: string;
  readonly candidateAgentIds: readonly string[];
}

declare const agentRuntimeInput: AgentRuntimeProviderInput;
declare const routerInput: RouterProviderInput;

// @ts-expect-error Router input cannot be passed to the full Agent runtime Provider.
const invalidAgentInput: AgentRuntimeProviderInput = routerInput;
// @ts-expect-error Full Agent runtime context cannot be passed to the Router Provider.
const invalidRouterInput: RouterProviderInput = agentRuntimeInput;

void invalidAgentInput;
void invalidRouterInput;
