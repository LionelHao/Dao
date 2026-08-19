import {
  GOVERNANCE_IPC_CHANNELS,
  cloneDepartureConflictList,
  cloneGovernanceRemoteState,
  cloneGovernanceStateEnvelope,
  cloneGovernanceSubmitResult,
  isGovernanceDepartureQuery,
  isGovernanceMutationRequest,
  isGovernanceStateEnvelope,
  isGovernanceSurfaceQuery,
  type GovernanceBridge,
  type GovernanceDepartureQuery,
  type GovernanceMutationRequest,
  type GovernanceStateEnvelope,
  type GovernanceSurfaceQuery,
} from "./contracts.js";

type Listener = (event: unknown, value: unknown) => void;
export interface GovernanceIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createGovernanceBridge(ipcRenderer: GovernanceIpcRenderer): GovernanceBridge {
  return Object.freeze({
    async getSurface(query: GovernanceSurfaceQuery) {
      if (!isGovernanceSurfaceQuery(query)) {
        throw new TypeError("Invalid Governance surface query");
      }
      return cloneGovernanceRemoteState(
        await ipcRenderer.invoke(GOVERNANCE_IPC_CHANNELS.getSurface, query),
      );
    },
    async getDepartureConflicts(query: GovernanceDepartureQuery) {
      if (!isGovernanceDepartureQuery(query)) {
        throw new TypeError("Invalid Governance conflicts query");
      }
      return cloneDepartureConflictList(
        await ipcRenderer.invoke(GOVERNANCE_IPC_CHANNELS.getDepartureConflicts, query),
      );
    },
    async submit(request: GovernanceMutationRequest) {
      if (!isGovernanceMutationRequest(request)) {
        throw new TypeError("Invalid Governance mutation request");
      }
      return cloneGovernanceSubmitResult(
        await ipcRenderer.invoke(GOVERNANCE_IPC_CHANNELS.submit, request),
      );
    },
    onStateChanged(listener: (state: GovernanceStateEnvelope) => void) {
      if (typeof listener !== "function") throw new TypeError("Governance state listener is invalid");
      const wrapped: Listener = (_event, value) => {
        if (!isGovernanceStateEnvelope(value)) return;
        listener(cloneGovernanceStateEnvelope(value));
      };
      ipcRenderer.on(GOVERNANCE_IPC_CHANNELS.stateChanged, wrapped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(GOVERNANCE_IPC_CHANNELS.stateChanged, wrapped);
      };
    },
  });
}
