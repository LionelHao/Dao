import type { ToolId } from "@native-im/core";
import { parseToolParameters, type ParsedToolParameters } from "./tool-parameters.js";

const physical: ToolId = "http-json.read";
// @ts-expect-error Internal source seams never enter the physical canonicalizer.
const internal: ToolId = "room-memory.read";

const parsed = parseToolParameters({ toolId: physical, argumentsJson: "{\"path\":\"release\"}" });
if (parsed.toolId === "http-json.read") {
  const path: string = parsed.parsed.path;
  // @ts-expect-error HTTP parameters never carry arbitrary headers.
  const headers = parsed.parsed.headers;
  void path;
  void headers;
}

declare const result: ParsedToolParameters;
if (result.toolId === "repository.git-status") {
  // @ts-expect-error Git status parameters cannot select cwd.
  const cwd = result.parsed.cwd;
  void cwd;
}

void internal;
