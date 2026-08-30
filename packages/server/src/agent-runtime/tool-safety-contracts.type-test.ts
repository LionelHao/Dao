import type { PublicToolSafetyProjection } from "@native-im/core";
import type { DispatchPermit } from "./tool-safety-contracts.js";

declare const publicProjection: PublicToolSafetyProjection;
// @ts-expect-error Public display facts are not adapter dispatch authority.
const forgedPermit: DispatchPermit = publicProjection;
const parsedJson: unknown = JSON.parse("{}");
// @ts-expect-error JSON cannot synthesize the non-serializable unique-symbol brand.
const jsonPermit: DispatchPermit = parsedJson;

void forgedPermit;
void jsonPermit;
