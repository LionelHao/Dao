import type { Ft07AgentSettingsAuthorityTransport } from "../websocket.js";
import type { AgentSettingsProjectionSyncStore } from "../sync-service.js";
import type { CompleteWorkerDatabaseClient } from "../persistence/worker-database-client.js";

/** One closed production adapter shared by WebSocket command/query and sync/repair. */
export class WorkerAgentSettingsAdapter implements
  Ft07AgentSettingsAuthorityTransport, AgentSettingsProjectionSyncStore {
  constructor(
    private readonly worker: Pick<CompleteWorkerDatabaseClient, "executeAgentSettings">,
    private readonly nowMs: () => number = Date.now,
  ) {}

  executeQuery(context: Parameters<Ft07AgentSettingsAuthorityTransport["executeQuery"]>[0],
    frame: Parameters<Ft07AgentSettingsAuthorityTransport["executeQuery"]>[1]) {
    return this.worker.executeAgentSettings(context, frame, this.nowMs());
  }

  executeMutation(context: Parameters<Ft07AgentSettingsAuthorityTransport["executeMutation"]>[0],
    frame: Parameters<Ft07AgentSettingsAuthorityTransport["executeMutation"]>[1]) {
    return this.worker.executeAgentSettings(context, frame, this.nowMs());
  }

  syncAgentProfiles(context: Parameters<AgentSettingsProjectionSyncStore["syncAgentProfiles"]>[0],
    input: Parameters<AgentSettingsProjectionSyncStore["syncAgentProfiles"]>[1]) {
    return this.worker.executeAgentSettings(context, {
      type: "agent-profile.sync", requestId: input.requestId,
      ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }), limit: input.limit,
    }, this.nowMs());
  }

  repairAgentProfiles(context: Parameters<AgentSettingsProjectionSyncStore["repairAgentProfiles"]>[0],
    requestId: string) {
    return this.worker.executeAgentSettings(context,
      { type: "agent-profile.repair", requestId }, this.nowMs());
  }

  repairRoomAgentAssignments(
    context: Parameters<AgentSettingsProjectionSyncStore["repairRoomAgentAssignments"]>[0],
    requestId: string,
    roomId: string,
  ) {
    return this.worker.executeAgentSettings(context,
      { type: "room-agent-assignment.repair", requestId, roomId }, this.nowMs());
  }
}
