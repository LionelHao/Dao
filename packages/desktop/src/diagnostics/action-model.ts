import {
  isDiagnosticsClosedError,
  type DiagnosticsBridge,
  type DiagnosticsClosedError,
} from "./contracts.js";

export type DiagnosticsActionState = Readonly<{
  status: "idle" | "saving" | "saved" | "cancelled" | "failed";
  disabled: boolean;
  ariaLive: "off" | "polite" | "assertive";
  announcement: string;
  error?: DiagnosticsClosedError;
}>;

export interface DiagnosticsActionModel {
  getState(): DiagnosticsActionState;
  subscribe(listener: (state: DiagnosticsActionState) => void): () => void;
  save(): Promise<void>;
  reset(): void;
}

const idle = (): DiagnosticsActionState => Object.freeze({
  status: "idle" as const, disabled: false, ariaLive: "off" as const, announcement: "",
});

function failed(error: DiagnosticsClosedError): DiagnosticsActionState {
  const message = error.status === 401 ? "认证已失效，请重新登录后重试。" :
    error.status === 403 ? "当前账号不再具有租户管理员权限。" :
      error.status === 409 ? "诊断包读取状态已变化，请重新导出。" :
        error.status === 410 ? "诊断包已过期，请重新生成。" :
          error.status === 429 ? "诊断导出繁忙，请稍后重试。" :
            "诊断导出暂不可用，请稍后重试。";
  return Object.freeze({ status: "failed" as const, disabled: false,
    ariaLive: "assertive" as const, announcement: message, error: structuredClone(error) });
}

function closedError(error: unknown): DiagnosticsClosedError {
  if (typeof error === "object" && error !== null && "diagnosticsError" in error &&
      isDiagnosticsClosedError(error.diagnosticsError)) return structuredClone(error.diagnosticsError);
  return { status: 503, code: "diagnostics_unavailable" };
}

/** Renderer-safe state only; artifact content, filenames, native paths, and session material stay absent. */
export function createDiagnosticsActionModel(bridge: DiagnosticsBridge): DiagnosticsActionModel {
  let state = idle();
  let pending: Promise<void> | undefined;
  const listeners = new Set<(state: DiagnosticsActionState) => void>();

  function publish(next: DiagnosticsActionState): void {
    state = next;
    for (const listener of [...listeners]) listener(structuredClone(next));
  }

  const model: DiagnosticsActionModel = {
    getState: () => structuredClone(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save() {
      if (pending !== undefined) return pending;
      publish(Object.freeze({ status: "saving" as const, disabled: true,
        ariaLive: "polite" as const, announcement: "正在生成无正文诊断包。" }));
      const operation = bridge.save().then((result) => {
        publish(Object.freeze(result.status === "saved"
          ? { status: "saved" as const, disabled: false, ariaLive: "polite" as const,
              announcement: "诊断包已保存。" }
          : { status: "cancelled" as const, disabled: false, ariaLive: "polite" as const,
              announcement: "已取消诊断包保存。" }));
      }).catch((error: unknown) => publish(failed(closedError(error)))).finally(() => {
        if (pending === operation) pending = undefined;
      });
      pending = operation;
      return operation;
    },
    reset() {
      if (pending === undefined) publish(idle());
    },
  };
  return Object.freeze(model);
}
