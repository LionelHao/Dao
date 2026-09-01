import {
  DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES,
  DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES,
  isDiagnosticsTransportServerFrame,
  type DiagnosticsTransportClientFrame,
  type DiagnosticsTransportServerFrame,
} from "@native-im/core";

export const DIAGNOSTICS_LIMITS = Object.freeze({
  maxChunkBytes: DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES,
  maxBytes: DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES,
  maxEntries: 10_000,
  maxLineBytes: 8_192,
} as const);

export type DiagnosticsGenerateCommand = Extract<DiagnosticsTransportClientFrame,
  { type: "diagnostics.generate" }>;
export type DiagnosticsReadCommand = Extract<DiagnosticsTransportClientFrame,
  { type: "diagnostics.read" }>;
export type DiagnosticsAbortCommand = Extract<DiagnosticsTransportClientFrame,
  { type: "diagnostics.abort" }>;
export type DiagnosticsGenerated = Extract<DiagnosticsTransportServerFrame,
  { type: "diagnostics.generated" }>;
export type DiagnosticsChunk = Extract<DiagnosticsTransportServerFrame,
  { type: "diagnostics.chunk" }>;
export type DiagnosticsAborted = Extract<DiagnosticsTransportServerFrame,
  { type: "diagnostics.aborted" }>;

export const isDiagnosticsGenerated = (value: unknown): value is DiagnosticsGenerated =>
  isDiagnosticsTransportServerFrame(value) && value.type === "diagnostics.generated";
export const isDiagnosticsChunk = (value: unknown): value is DiagnosticsChunk =>
  isDiagnosticsTransportServerFrame(value) && value.type === "diagnostics.chunk";
export const isDiagnosticsAborted = (value: unknown): value is DiagnosticsAborted =>
  isDiagnosticsTransportServerFrame(value) && value.type === "diagnostics.aborted";
