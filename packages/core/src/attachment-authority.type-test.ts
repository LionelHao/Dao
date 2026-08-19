import type {
  AttachmentError,
  AttachmentMetadata,
  AttachmentPrivateEvent,
  AttachmentRepairRecord,
  AttachmentRoomEvent,
  AttachmentUiAxes,
  AttachmentUiState,
} from "./attachment-authority.js";

declare const metadata: AttachmentMetadata;
declare const privateEvent: AttachmentPrivateEvent;
declare const roomEvent: AttachmentRoomEvent;
declare const repair: AttachmentRepairRecord;
declare const error: AttachmentError;
declare const axes: AttachmentUiAxes;
declare const state: AttachmentUiState;

// @ts-expect-error Filesystem paths never cross the Core attachment boundary.
const localPath: string = metadata.path;
// @ts-expect-error Arbitrary URLs are not attachment authority facts.
const arbitraryUrl: string = metadata.url;
// @ts-expect-error Session/bearer tokens are not serializable attachment facts.
const token: string = metadata.token;
// @ts-expect-error Raw bytes never enter Core metadata, event, outbox, or repair contracts.
const bytes: Uint8Array = metadata.bytes;
// @ts-expect-error Extracted text stays in the server-controlled artifact store.
const extractedText: string = metadata.extractedText;
// @ts-expect-error Adapter stdout/stderr is normalized before any authority fact.
const rawScannerOutput: string = metadata.rawScannerOutput;

// @ts-expect-error Private events cannot claim a Room stream envelope.
const privateRoomId: string = privateEvent.roomId;
// @ts-expect-error Room events never carry one-shot handles.
const streamHandle: string = roomEvent.streamHandle;
// @ts-expect-error Repair records never carry an object-store key.
const objectKey: string = repair.objectKey;
// @ts-expect-error Closed errors expose no diagnostic details or stack.
const errorDetails: unknown = error.details;
// @ts-expect-error UI axes expose no local filesystem selection path.
const selectionPath: string = axes.selectionPath;

const closedUiState: AttachmentUiState = state;

void localPath;
void arbitraryUrl;
void token;
void bytes;
void extractedText;
void rawScannerOutput;
void privateRoomId;
void streamHandle;
void objectKey;
void errorDetails;
void selectionPath;
void closedUiState;
