import type {
  ProjectBallFact,
  ProjectBlocker,
  ProjectNextAction,
  ProjectOpenQuestion,
  ProjectRequest,
  ProjectSourceRef,
  ProjectTransferProposal,
} from "./project-loop.js";

declare const source: ProjectSourceRef;
declare const request: ProjectRequest;
declare const action: ProjectNextAction;
declare const blocker: ProjectBlocker;
declare const question: ProjectOpenQuestion;
declare const transfer: ProjectTransferProposal;
declare const ball: ProjectBallFact;

// @ts-expect-error Public project sources are room-visible references, never private raw values.
const privateSource: ProjectSourceRef = { ...source, visibility: "private" };
// @ts-expect-error An Agent cannot be the requester in the @Human Request handshake.
const agentRequester: ProjectRequest = { ...request, requester: { kind: "agent", actorId: "agent-1" } };
// @ts-expect-error NextAction exposes acceptanceCriteria, not a legacy LightTask criteria field.
const legacyCriteria = action.criteria;
// @ts-expect-error Blockers carry resolution criteria and never carry question text.
const blockerQuestion: string = blocker.question;
// @ts-expect-error OpenQuestions carry question text and never carry blocker resolution criteria.
const questionCriteria: string = question.resolutionCriteria;
// @ts-expect-error A transfer subject revision is immutable input to its CAS decision.
transfer.subjectRevision = 2;
// @ts-expect-error Ball boundary identity is immutable and server-generated.
ball.boundaryId = "forged-boundary";
// @ts-expect-error Project facts never expose raw source message bodies.
const rawBody: string = request.body;

void privateSource;
void agentRequester;
void legacyCriteria;
void blockerQuestion;
void questionCriteria;
void rawBody;
