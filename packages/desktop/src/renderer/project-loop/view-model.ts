import {
  isProjectSnapshot,
  type ProjectBallFact,
  type ProjectConfirmation,
  type ProjectDecision,
  type ProjectGoal,
  type ProjectNextAction,
  type ProjectObstacle,
  type ProjectProposal,
  type ProjectRequest,
  type ProjectSnapshot,
  type ProjectTransferProposal,
} from "@native-im/core";

export type ProjectLoopConnection =
  | { readonly status: "online" }
  | { readonly status: "offline"; readonly asOf: string }
  | { readonly status: "repairing" }
  | { readonly status: "repair_failed"; readonly code: string };

export type ProjectLoopErrorStatus = 401 | 403 | 409 | 410 | 429 | 503;
export type ProjectLoopOperation =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly intentId: string }
  | { readonly status: "acknowledged"; readonly intentId: string; readonly acceptedRevision: number }
  | {
      readonly status: "failed";
      readonly intentId: string;
      readonly error: Readonly<{
        status: ProjectLoopErrorStatus;
        code: string;
        retryAfterSeconds?: number;
      }>;
    };

export type ProjectLoopRemoteState =
  | { readonly status: "loading"; readonly roomId: string }
  | {
      readonly status: "locked";
      readonly roomId: string;
      readonly error: Readonly<{ status: 401 | 410 | 503; code: string }>;
    }
  | {
      readonly status: "ready";
      readonly roomId: string;
      readonly snapshot: ProjectSnapshot;
      readonly viewerActorId: string;
      readonly connection: ProjectLoopConnection;
      readonly operation: ProjectLoopOperation;
    };

export type ProjectLoopCategory =
  | "goals" | "decisions" | "requests" | "obstacles" | "next_actions" | "ball";

export interface ProjectLoopViewModel {
  readonly roomId: string;
  readonly revision: number;
  readonly capturedAt: string;
  readonly connection: ProjectLoopConnection;
  readonly operation: ProjectLoopOperation;
  readonly goals: readonly ProjectGoal[];
  readonly decisions: readonly ProjectDecision[];
  readonly requests: readonly ProjectRequest[];
  readonly obstacles: readonly ProjectObstacle[];
  readonly nextActions: readonly ProjectNextAction[];
  readonly proposals: readonly ProjectProposal[];
  readonly confirmations: readonly ProjectConfirmation[];
  readonly transferProposals: readonly ProjectTransferProposal[];
  readonly balls: readonly ProjectBallFact[];
  readonly confirmableProposals: readonly ProjectProposal[];
  readonly empty: boolean;
  readonly mutationDisabled: boolean;
  readonly announcement: string;
}

function announcement(state: Extract<ProjectLoopRemoteState, { status: "ready" }>): string {
  if (state.connection.status === "offline") return "项目状态离线，只读已校验缓存；写操作已禁用。";
  if (state.connection.status === "repairing") return "正在修复项目权威状态。";
  if (state.connection.status === "repair_failed") return "项目状态修复失败；保留旧的完整只读快照。";
  if (state.operation.status === "submitting") return "项目意图正在提交，尚未成为权威事实。";
  if (state.operation.status === "acknowledged") return "服务端已接受项目意图，等待稳定事件或投影收敛。";
  if (state.operation.status === "failed") {
    const messages: Record<ProjectLoopErrorStatus, string> = {
      401: "身份已失效，请重新登录。",
      403: "没有执行此项目操作的权限，当前事实仍可阅读。",
      409: "项目版本已变化，请刷新后重新确认。",
      410: "Room 或项目来源已不可操作。",
      429: "操作过于频繁，请按服务端提示稍后重试。",
      503: "项目权威服务暂不可用，未提交任何本地成功状态。",
    };
    return messages[state.operation.error.status];
  }
  return "项目权威状态已同步。";
}

export function createProjectLoopViewModel(
  state: Extract<ProjectLoopRemoteState, { status: "ready" }>,
): ProjectLoopViewModel {
  if (!isProjectSnapshot(state.snapshot) || state.snapshot.roomId !== state.roomId ||
      state.snapshot.projectId !== state.roomId) {
    throw new TypeError("Project Loop snapshot is not a closed Room-scoped projection");
  }
  const facts = [
    ...state.snapshot.goals,
    ...state.snapshot.decisions,
    ...state.snapshot.requests,
    ...state.snapshot.obstacles,
    ...state.snapshot.nextActions,
  ];
  const confirmableProposals = state.snapshot.proposals.filter((proposal) =>
    proposal.state === "pending" && proposal.principalActorId === state.viewerActorId);
  return Object.freeze({
    roomId: state.roomId,
    revision: state.snapshot.watermark,
    capturedAt: state.snapshot.capturedAt,
    connection: state.connection,
    operation: state.operation,
    goals: state.snapshot.goals,
    decisions: state.snapshot.decisions,
    requests: state.snapshot.requests,
    obstacles: state.snapshot.obstacles,
    nextActions: state.snapshot.nextActions,
    proposals: state.snapshot.proposals,
    confirmations: state.snapshot.confirmations,
    transferProposals: state.snapshot.transferProposals,
    balls: state.snapshot.balls,
    confirmableProposals,
    empty: facts.length === 0 && state.snapshot.proposals.length === 0 &&
      state.snapshot.transferProposals.length === 0 && state.snapshot.balls.length === 0,
    mutationDisabled: state.connection.status !== "online" || state.operation.status === "submitting" ||
      state.operation.status === "failed" &&
        (state.operation.error.status === 401 || state.operation.error.status === 403 ||
          state.operation.error.status === 410),
    announcement: announcement(state),
  });
}
