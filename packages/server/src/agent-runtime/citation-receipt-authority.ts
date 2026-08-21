import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";

export type CitationReceiptSourceKind =
  | "message_revision"
  | "message_tombstone"
  | "attachment_extraction"
  | "memory"
  | "project_fact_checkpoint"
  | "delta_range";

export interface CitationReceiptBinding {
  readonly roomId: string;
  readonly executionId: string;
  readonly snapshotId: string;
  readonly snapshotGeneration: number;
  readonly sourceLabel: string;
  readonly sourceKind: CitationReceiptSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly authorizationEpoch: number;
  readonly representation: "source" | "neighbors" | "attachment_segment" | "memory_sources";
  readonly range: string;
  readonly contentSha256: string;
  readonly contentBytes: number;
}

export interface CitationReceiptRecord extends CitationReceiptBinding {
  readonly labelHash: string;
  readonly state: "successful";
}

export interface CitationReceiptStore {
  insert(record: CitationReceiptRecord): Promise<boolean>;
  findByLabelHash(labelHash: string): Promise<CitationReceiptRecord | undefined>;
}

export type CitationValidationTarget =
  | Readonly<{ kind: "manifest"; label: string }>
  | Readonly<{ kind: "receipt"; label: string; receipt: CitationReceiptRecord }>;

export interface CitationDeclarationValidationInput {
  readonly roomId: string;
  readonly executionId: string;
  readonly snapshotId: string;
  readonly snapshotGeneration: number;
  readonly declarations: readonly string[];
  readonly manifestLabels: readonly string[];
  revalidate(target: CitationValidationTarget): Promise<boolean>;
}

export interface CitationReceiptAuthority {
  issue(binding: CitationReceiptBinding): Promise<Readonly<{ citationLabel: string }>>;
  validateDeclarations(input: CitationDeclarationValidationInput): Promise<readonly string[]>;
}

export class CitationReceiptError extends Error {
  constructor(
    readonly status: 409 | 410 | 503,
    readonly code: "citation_declaration_invalid" | "citation_source_invalidated" |
      "citation_authority_unavailable",
  ) {
    super(`Citation declaration rejected: ${code}`);
    this.name = "CitationReceiptError";
    delete this.stack;
  }
}

function identifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value.normalize("NFC") === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hashLabel(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function validateBinding(binding: CitationReceiptBinding): void {
  if (!identifier(binding.roomId) || !identifier(binding.executionId) || !identifier(binding.snapshotId) ||
      !positive(binding.snapshotGeneration) || !identifier(binding.sourceLabel) || !identifier(binding.sourceId) ||
      !positive(binding.sourceRevision) || !nonnegative(binding.authorizationEpoch) ||
      !["message_revision", "message_tombstone", "attachment_extraction", "memory", "project_fact_checkpoint", "delta_range"]
        .includes(binding.sourceKind) ||
      !["source", "neighbors", "attachment_segment", "memory_sources"].includes(binding.representation) ||
      !identifier(binding.range, 1_024) || !/^[a-f0-9]{64}$/u.test(binding.contentSha256) ||
      !nonnegative(binding.contentBytes) || binding.contentBytes > 32_768) {
    throw new CitationReceiptError(409, "citation_declaration_invalid");
  }
}

function sameBinding(
  receipt: CitationReceiptRecord,
  input: Readonly<{ roomId: string; executionId: string; snapshotId: string; snapshotGeneration: number }>,
): boolean {
  return receipt.state === "successful" && receipt.roomId === input.roomId &&
    receipt.executionId === input.executionId && receipt.snapshotId === input.snapshotId &&
    receipt.snapshotGeneration === input.snapshotGeneration;
}

export function createCitationReceiptAuthority(options: Readonly<{
  store: CitationReceiptStore;
  randomBytes?: (size: number) => Uint8Array;
}>): CitationReceiptAuthority {
  const random = options.randomBytes ?? ((size: number) => cryptoRandomBytes(size));

  return Object.freeze({
    async issue(binding: CitationReceiptBinding) {
      validateBinding(binding);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let entropy: Uint8Array;
        try {
          entropy = random(32);
        } catch {
          throw new CitationReceiptError(503, "citation_authority_unavailable");
        }
        if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
          throw new CitationReceiptError(503, "citation_authority_unavailable");
        }
        const citationLabel = `read:${Buffer.from(entropy).toString("base64url")}`;
        const record: CitationReceiptRecord = Object.freeze({
          ...binding,
          labelHash: hashLabel(citationLabel),
          state: "successful",
        });
        try {
          if (await options.store.insert(record)) return Object.freeze({ citationLabel });
        } catch {
          throw new CitationReceiptError(503, "citation_authority_unavailable");
        }
      }
      throw new CitationReceiptError(503, "citation_authority_unavailable");
    },

    async validateDeclarations(input: CitationDeclarationValidationInput): Promise<readonly string[]> {
      if (!identifier(input.roomId) || !identifier(input.executionId) || !identifier(input.snapshotId) ||
          !positive(input.snapshotGeneration) || !Array.isArray(input.declarations) ||
          input.declarations.length > 128 || !input.declarations.every((entry) => identifier(entry)) ||
          !Array.isArray(input.manifestLabels) || input.manifestLabels.length > 4_096 ||
          !input.manifestLabels.every((entry) => identifier(entry)) ||
          typeof input.revalidate !== "function") {
        throw new CitationReceiptError(409, "citation_declaration_invalid");
      }
      const manifest = new Set(input.manifestLabels);
      const declarations = [...new Set(input.declarations)].sort();
      for (const declaration of declarations) {
        let target: CitationValidationTarget;
        if (manifest.has(declaration)) {
          target = Object.freeze({ kind: "manifest", label: declaration });
        } else {
          let receipt: CitationReceiptRecord | undefined;
          try {
            receipt = await options.store.findByLabelHash(hashLabel(declaration));
          } catch {
            throw new CitationReceiptError(503, "citation_authority_unavailable");
          }
          if (receipt === undefined || !sameBinding(receipt, input)) {
            throw new CitationReceiptError(409, "citation_declaration_invalid");
          }
          target = Object.freeze({ kind: "receipt", label: declaration, receipt });
        }
        let current: boolean;
        try {
          current = await input.revalidate(target);
        } catch {
          throw new CitationReceiptError(503, "citation_authority_unavailable");
        }
        if (!current) throw new CitationReceiptError(410, "citation_source_invalidated");
      }
      return Object.freeze(declarations);
    },
  });
}
