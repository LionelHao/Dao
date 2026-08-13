export type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeJsonValue[]
  | { readonly [key: string]: RuntimeJsonValue };

export type AgentInvocationIntentKind =
  | "direct_mention"
  | "structured_help"
  | "routed_candidate";

export interface AgentRuntimeInvocationIntent {
  readonly sourceMessageId: string;
  readonly requesterActorId: string;
  readonly targetAgentId: string;
  readonly intentKind: AgentInvocationIntentKind;
}

export interface AuthorizedConversationEntry {
  readonly messageId: string;
  readonly actorId: string;
  readonly body: string;
}

export type ToolConfirmationRequirement = "read_only" | "side_effect";

export interface AgentRuntimeToolDescriptor {
  readonly id: string;
  readonly description: string;
  readonly confirmationRequirement: ToolConfirmationRequirement;
  readonly parametersSchema: { readonly [key: string]: RuntimeJsonValue };
}

export type ProviderNeutralCheckpointKind =
  | "model_generation"
  | "tool_call"
  | "tool_result";

export interface ProviderNeutralCheckpoint {
  readonly stepSeq: number;
  readonly kind: ProviderNeutralCheckpointKind;
  readonly modelInput: RuntimeJsonValue;
}

export interface AgentRuntimeContextLimits {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
}

export interface AgentRuntimeProviderInput {
  readonly purpose: "agent_runtime";
  readonly invocation: AgentRuntimeInvocationIntent;
  readonly visibleConversation: readonly AuthorizedConversationEntry[];
  readonly availableTools: readonly AgentRuntimeToolDescriptor[];
  readonly committedSteps: readonly ProviderNeutralCheckpoint[];
  readonly limits: AgentRuntimeContextLimits;
}

export type ProviderEvent =
  | { readonly type: "response_started" }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "tool_call_delta";
      readonly callId: string;
      readonly toolId: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly type: "completed";
      readonly finishReason: "stop" | "tool_calls";
    };

export interface ProviderAdapter {
  readonly id: string;
  stream(
    input: AgentRuntimeProviderInput,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}

export interface SecretProvider {
  read(environmentKey: string): string | undefined;
}

export interface AgentRuntimeToolOutcome {
  readonly modelInput: Exclude<RuntimeJsonValue, null>;
  readonly closedSummary: string;
  readonly sealedCompensation?: string;
}

export interface AgentRuntimeToolAdapter {
  readonly descriptor: AgentRuntimeToolDescriptor;
  execute(parameters: RuntimeJsonValue, signal: AbortSignal): Promise<AgentRuntimeToolOutcome>;
}

export interface AgentRuntimeCompensatableToolAdapter extends AgentRuntimeToolAdapter {
  compensate(sealedCompensation: string, signal: AbortSignal): Promise<AgentRuntimeToolOutcome>;
}

export interface AgentExecutionPreview {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly streamSeq: number;
  readonly text: string;
}
