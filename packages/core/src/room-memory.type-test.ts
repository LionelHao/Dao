import type {
  RoomMemoryContextDisputeRequest,
  RoomMemoryContextResolveRequest,
  RoomMemoryQueryRequest,
  RoomMemoryRawDeltaPage,
  RoomMemoryRepairRecord,
  RoomMemoryRetryRequest,
  RoomMemorySource,
  RoomMemoryVersion,
} from "./room-memory.js";

declare const dispute: RoomMemoryContextDisputeRequest;
declare const resolve: RoomMemoryContextResolveRequest;
declare const query: RoomMemoryQueryRequest;
declare const retry: RoomMemoryRetryRequest;
declare const source: RoomMemorySource;
declare const version: RoomMemoryVersion;
declare const delta: RoomMemoryRawDeltaPage;
declare const repair: RoomMemoryRepairRecord;

// @ts-expect-error Public dispute commands cannot choose the authenticated Human actor.
const forgedDisputer: RoomMemoryContextDisputeRequest = { ...dispute, actorId: "human-1" };
// @ts-expect-error Public resolve commands cannot claim the built-in steward identity.
const forgedSteward: RoomMemoryContextResolveRequest = { ...resolve, stewardId: "steward-1" };
// @ts-expect-error Public mutation commands cannot submit an active authority state.
const forgedActive: RoomMemoryContextResolveRequest = { ...resolve, state: "active" };
// @ts-expect-error Public mutation commands cannot claim a confirmed project fact.
const forgedConfirmed: RoomMemoryContextResolveRequest = { ...resolve, confirmed: true };
// @ts-expect-error Public query commands cannot select a server watermark.
const forgedWatermark: RoomMemoryQueryRequest = { ...query, memoryWatermark: 42 };
// @ts-expect-error Public retry commands cannot override source eligibility.
const forgedEligibility: RoomMemoryRetryRequest = { ...retry, eligibility: "eligible" };
// @ts-expect-error Public retry commands cannot override source revision.
const forgedRevision: RoomMemoryRetryRequest = { ...retry, sourceRevision: 3 };
// @ts-expect-error Provider metadata is server-private and cannot enter a public request.
const forgedProvider: RoomMemoryQueryRequest = { ...query, providerMetadata: { model: "secret" } };

// @ts-expect-error Corpus source indexes never contain raw message bodies.
const rawBody: string = source.body;
// @ts-expect-error Corpus source indexes never duplicate attachment extraction text.
const extraction: string = source.extractedText;
// @ts-expect-error Corpus source indexes never expose filesystem paths.
const sourcePath: string = source.path;
// @ts-expect-error Corpus source indexes never expose bearer or object tokens.
const sourceToken: string = source.token;
// @ts-expect-error Validated memory versions cannot carry a fake Human confirmer.
const fakeConfirmer: string = version.confirmedByActorId;
// @ts-expect-error Raw delta pages contain opaque authorized read references, not source bodies.
const deltaBody: string = delta.body;
// @ts-expect-error Raw delta pages do not expose Provider transport metadata.
const providerHeaders: unknown = delta.providerHeaders;
// @ts-expect-error Repair records never carry prompts or hidden reasoning.
const repairPrompt: string = repair.prompt;

void forgedDisputer;
void forgedSteward;
void forgedActive;
void forgedConfirmed;
void forgedWatermark;
void forgedEligibility;
void forgedRevision;
void forgedProvider;
void rawBody;
void extraction;
void sourcePath;
void sourceToken;
void fakeConfirmer;
void deltaBody;
void providerHeaders;
void repairPrompt;
