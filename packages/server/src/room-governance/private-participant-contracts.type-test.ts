import type {
  ArchivedMessageGate,
  AuthorityTransactionView,
} from "./private-participant-contracts.js";
import type { ClientFrame } from "../protocol.js";

// @ts-expect-error Transaction capabilities must not be exported from the package root.
import type { AuthorityTransactionView as PublicAuthorityTransactionView } from "../index.js";
// @ts-expect-error Participant registrations must not be exported from the package root.
import type { ParticipantRegistration as PublicParticipantRegistration } from "../index.js";

type Assert<T extends true> = T;

type JsonTransactionCandidate = Readonly<{
  roomId: "room-1";
  transactionId: "tx-1";
}>;

type JsonFrameWithTransactionCapability = Readonly<{
  type: "room.archive";
  requestId: "request-1";
  transaction: JsonTransactionCandidate;
  participant: ArchivedMessageGate;
}>;

export type PackageRootTransactionCapabilityStaysPrivate = PublicAuthorityTransactionView;
export type PackageRootParticipantRegistrationStaysPrivate = PublicParticipantRegistration;
export type JsonCannotConstructTransactionCapability = Assert<
  JsonTransactionCandidate extends AuthorityTransactionView ? false : true
>;
export type ProtocolCannotCarryTransactionOrParticipant = Assert<
  JsonFrameWithTransactionCapability extends ClientFrame ? false : true
>;
