import {
  asAgentActorId,
  asAgentAssignmentId,
  asAgentProfileId,
  type AgentActorId,
  type AgentAssignmentId,
  type AgentAssignmentRecord,
  type AgentAvailability,
  type AgentAssignmentParticipation,
  type AgentProfileId,
  type AgentProfileRecord,
} from "./index.js";

const actorId = asAgentActorId("agent-1");
const profileId = asAgentProfileId("profile-1");
const assignmentId = asAgentAssignmentId("assignment-1");

// @ts-expect-error Stable Agent actor IDs cannot be used as Profile IDs.
const profileFromActor: AgentProfileId = actorId;
// @ts-expect-error Stable Profile IDs cannot be used as Assignment IDs.
const assignmentFromProfile: AgentAssignmentId = profileId;
// @ts-expect-error Display names cannot be used as stable actor IDs.
const actorFromDisplayName: AgentActorId = "Reviewer";

const participation: AgentAssignmentParticipation = "active";
const availability: AgentAvailability = "ready";
void participation;
void availability;

// @ts-expect-error `silent` is not a production participation state.
const silentParticipation: AgentAssignmentParticipation = "silent";
// @ts-expect-error Availability cannot be written as participation.
const writableAvailability: AgentAssignmentParticipation = "paused";

const profile: AgentProfileRecord = {
  profileId, actorId, displayName: "Reviewer", globalResponsibility: "Review changes.",
  status: "enabled", capabilityCeiling: ["room.conversation.read"],
  toolCeiling: ["repository.git-status"], revision: 1,
  createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
};

const assignment: AgentAssignmentRecord = {
  assignmentId, roomId: "room-1", profileId, actorId,
  roomResponsibility: "Review this Room.", status: "current", participation: "active",
  paused: false, capabilitySubset: ["room.conversation.read"],
  toolSubset: ["repository.git-status"], revision: 1,
  createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
};

const forgedProfile: AgentProfileRecord = {
  ...profile,
  // @ts-expect-error Unknown capabilities fail at the public type boundary.
  capabilityCeiling: ["shell.exec"],
};

const forgedAssignment: AgentAssignmentRecord = {
  ...assignment,
  // @ts-expect-error Unknown tools fail at the public type boundary.
  toolSubset: ["filesystem.write"],
};

void profileFromActor;
void assignmentFromProfile;
void actorFromDisplayName;
void silentParticipation;
void writableAvailability;
void profile;
void assignment;
void forgedProfile;
void forgedAssignment;
