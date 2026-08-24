import type { AgentSettingsBridge } from "../../agent-profile-routing/contracts.js";
import { applyAgentSettingsAuthorityMessage, beginAgentSettingsMutation,
  createAgentSettingsInitialState, createAgentSettingsViewModel } from "./view-model.js";
import { renderAgentSettingsSurface } from "./surface.js";

export function mountAgentSettingsBridgeSurface(root: HTMLElement, bridge: AgentSettingsBridge,
  roomId: string, options: { reducedMotion: boolean; onClose(): void }): () => void {
  let state = createAgentSettingsInitialState(options.reducedMotion);
  let disposed = false;
  const render = () => renderAgentSettingsSurface(root, createAgentSettingsViewModel(state), {
    onClose: options.onClose,
    onRecover: () => { void load(); },
    onIntent(intent) {
      if (state.operation.status === "submitting" || state.operation.status === "acknowledged") return;
      const requestId = `agent-settings-renderer-${crypto.randomUUID()}`;
      try { state = beginAgentSettingsMutation(state, { requestId, intent }); render(); }
      catch { return; }
      void bridge.submit({ requestId, intent }).catch((failure: unknown) => {
        if (disposed) return;
        const status = (failure as { status?: unknown }).status;
        const error = status === 401 ? { status: 401 as const, code: "authentication_required" as const }
          : status === 403 ? { status: 403 as const, code: "role_forbidden" as const }
          : status === 409 ? { status: 409 as const, code: "room_revision_conflict" as const }
          : status === 410 ? { status: 410 as const, code: "snapshot_expired" as const }
          : status === 429 ? { status: 429 as const, code: "rate_limited" as const }
          : { status: 503 as const, code: "authority_unavailable" as const };
        state = applyAgentSettingsAuthorityMessage(state,
          { type: "error", requestId, command: intent.command, error });
        render();
      });
    },
  });
  const load = async () => {
    try { const snapshot = await bridge.getSnapshot({ roomId });
      if (!disposed) { state = applyAgentSettingsAuthorityMessage(state, { type: "snapshot", snapshot }); render(); }
    } catch { if (!disposed) render(); }
  };
  const unsubscribe = bridge.onAuthorityMessage((message) => {
    if (!disposed) { state = applyAgentSettingsAuthorityMessage(state, message); render(); }
  });
  render(); void load();
  return () => { disposed = true; unsubscribe(); };
}
