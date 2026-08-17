import type { BlueprintBallFact } from "@native-im/core";

export interface BlueprintBallProjectionPort {
  readRoom(roomId: string, signal: AbortSignal): Promise<readonly BlueprintBallFact[]>;
}

export function createEmptyBlueprintBallProjectionPort(): BlueprintBallProjectionPort {
  return Object.freeze({
    async readRoom(_roomId: string, signal: AbortSignal) {
      if (signal.aborted) throw signal.reason;
      return [];
    },
  });
}
