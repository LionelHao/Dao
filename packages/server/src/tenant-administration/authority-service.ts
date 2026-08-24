import { createHash } from "node:crypto";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";

const MAX_ID_BYTES = 128;
const MAX_DISPLAY_NAME_BYTES = 120;
const MAX_RESPONSIBILITY_BYTES = 4_000;
const MAX_CONFIGURATION_DIGEST_BYTES = 256;

export type PrincipalKind = "human" | "agent";
export type AgentProfileStatus = "enabled" | "disabled";
export type CredentialReadiness = "ready" | "noauth";

export interface TenantAdministratorRegistry {
  readonly revision: number;
  readonly principalIds: readonly string[];
  readonly configurationDigest: string;
  readonly updatedAt: string;
}

export interface GlobalAgentProfile {
  readonly profileId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly status: AgentProfileStatus;
  readonly capabilityCeiling: readonly string[];
  readonly toolCeiling: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeploymentProviderDisclosure {
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialReadiness: CredentialReadiness;
}

export type DeploymentAuditAction =
  | "administrator.bootstrap"
  | "administrator.add"
  | "administrator.remove"
  | "profile.create"
  | "profile.update"
  | "profile.enable"
  | "profile.disable";

/** Fixed deployment-only shape. It deliberately cannot carry Room content or secret values. */
export interface DeploymentAuditRecord {
  readonly auditId: string;
  readonly action: DeploymentAuditAction;
  readonly actorId: string | null;
  readonly targetId: string;
  readonly revision: number;
  readonly requestId: string;
  readonly occurredAt: string;
}

export interface StoredReplay {
  readonly fingerprint: string;
  readonly result: unknown;
}

export type DeploymentProfileEventKind =
  | "profile.created"
  | "profile.updated"
  | "profile.enabled"
  | "profile.disabled";

/** Server-private deployment fact. Its closed shape cannot carry Room or credential data. */
export interface DeploymentProfileMutationRecord {
  readonly eventId: string;
  readonly eventKind: DeploymentProfileEventKind;
  readonly profile: GlobalAgentProfile;
  readonly previousRevision: number | null;
  readonly occurredAt: string;
}

/**
 * Private transaction seam for the single Authority SQLite writer.
 *
 * The adapter must execute the callback in the same transaction as session revalidation,
 * domain rows, immutable audit/revision rows, stable events/outbox and idempotency result.
 */
export interface TenantAdministrationTransaction {
  requireCurrentSession(context: AuthenticatedSessionContext): void;
  principalKind(principalId: string): PrincipalKind | undefined;
  readAdministratorRegistry(): TenantAdministratorRegistry | undefined;
  writeAdministratorRegistry(registry: TenantAdministratorRegistry): void;
  readProfile(profileId: string): GlobalAgentProfile | undefined;
  listProfiles(): readonly GlobalAgentProfile[];
  createAgentActor(actorId: string, displayName: string): void;
  writeProfile(profile: GlobalAgentProfile, credentialReadiness?: CredentialReadiness): void;
  appendProfileMutation(record: DeploymentProfileMutationRecord): void;
  readReplay(key: string): StoredReplay | undefined;
  writeReplay(key: string, fingerprint: string, result: unknown): void;
  appendAudit(record: DeploymentAuditRecord): void;
}

export interface TenantAdministrationRepository {
  transact<TResult>(operation: (transaction: TenantAdministrationTransaction) => TResult): Promise<TResult>;
}

export interface CurrentSessionAuthenticator {
  authenticateSession(accessToken: string): Promise<AuthenticatedSessionContext>;
}

export type TenantAdministrationErrorCode =
  | "invalid_bootstrap"
  | "bootstrap_conflict"
  | "human_principal_required"
  | "administrator_configuration_unavailable"
  | "administrator_required"
  | "administrator_already_exists"
  | "administrator_not_found"
  | "last_administrator_required"
  | "revision_conflict"
  | "idempotency_conflict"
  | "invalid_profile"
  | "profile_not_found"
  | "profile_state_conflict"
  | "profile_fanout_capacity_limited"
  | "configuration_unsupported";

export class TenantAdministrationError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 429 | 503;
  readonly code: TenantAdministrationErrorCode;

  constructor(
    status: 400 | 403 | 404 | 409 | 429 | 503,
    code: TenantAdministrationErrorCode,
  ) {
    super(code);
    this.name = "TenantAdministrationError";
    this.status = status;
    this.code = code;
  }
}

export interface TenantAdministrationAuthorityOptions {
  readonly sessions: CurrentSessionAuthenticator;
  readonly repository: TenantAdministrationRepository;
  readonly providerDisclosure: () => DeploymentProviderDisclosure;
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly clock?: () => string;
  readonly profileIdFactory: () => string;
  readonly actorIdFactory: () => string;
  readonly auditIdFactory: () => string;
  readonly profileEventIdFactory: () => string;
}

export interface TenantCommandContext {
  readonly accessToken: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface TenantAdministratorMutation {
  readonly targetPrincipalId: string;
  readonly expectedRevision: number;
}

export interface CreateGlobalProfileCommand {
  readonly expectedRevision: 0;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly capabilityCeiling: readonly string[];
  readonly toolCeiling: readonly string[];
}

export interface UpdateGlobalProfileCommand {
  readonly profileId: string;
  readonly expectedRevision: number;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly capabilityCeiling: readonly string[];
  readonly toolCeiling: readonly string[];
}

export interface TransitionGlobalProfileCommand {
  readonly profileId: string;
  readonly expectedRevision: number;
}

export interface TenantAdministrationAuthority {
  bootstrapFromOwnerConfiguration(input: {
    readonly principalIds: readonly string[];
    readonly configurationDigest: string;
  }): Promise<TenantAdministratorRegistry>;
  listAdministrators(accessToken: string): Promise<TenantAdministratorRegistry>;
  addAdministrator(context: TenantCommandContext, command: TenantAdministratorMutation):
    Promise<{ readonly registry: TenantAdministratorRegistry }>;
  removeAdministrator(context: TenantCommandContext, command: TenantAdministratorMutation):
    Promise<{ readonly registry: TenantAdministratorRegistry }>;
  queryProfiles(accessToken: string): Promise<{
    readonly profiles: readonly GlobalAgentProfile[];
    readonly provider: DeploymentProviderDisclosure;
  }>;
  getProfile(accessToken: string, profileId: string): Promise<{
    readonly profile: GlobalAgentProfile;
    readonly provider: DeploymentProviderDisclosure;
  }>;
  discloseProvider(accessToken: string): Promise<DeploymentProviderDisclosure>;
  createProfile(context: TenantCommandContext, command: CreateGlobalProfileCommand):
    Promise<{ readonly profile: GlobalAgentProfile }>;
  updateProfile(context: TenantCommandContext, command: UpdateGlobalProfileCommand):
    Promise<{ readonly profile: GlobalAgentProfile }>;
  enableProfile(context: TenantCommandContext, command: TransitionGlobalProfileCommand):
    Promise<{ readonly profile: GlobalAgentProfile }>;
  disableProfile(context: TenantCommandContext, command: TransitionGlobalProfileCommand):
    Promise<{ readonly profile: GlobalAgentProfile }>;
  rejectUnsupportedCredentialMutation(accessToken: string, opaqueInput: unknown): Promise<never>;
}

function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactCanonicalSet(
  values: readonly string[],
  allowed: ReadonlySet<string>,
): boolean {
  return values.every((entry, index) => validText(entry, MAX_ID_BYTES) && allowed.has(entry) &&
    (index === 0 || values[index - 1]!.localeCompare(entry) < 0));
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function freezeRegistry(registry: TenantAdministratorRegistry): TenantAdministratorRegistry {
  return Object.freeze({
    revision: registry.revision,
    principalIds: Object.freeze([...registry.principalIds]),
    configurationDigest: registry.configurationDigest,
    updatedAt: registry.updatedAt,
  });
}

function freezeProfile(profile: GlobalAgentProfile): GlobalAgentProfile {
  return Object.freeze({
    profileId: profile.profileId,
    actorId: profile.actorId,
    displayName: profile.displayName,
    globalResponsibility: profile.globalResponsibility,
    status: profile.status,
    capabilityCeiling: Object.freeze([...profile.capabilityCeiling]),
    toolCeiling: Object.freeze([...profile.toolCeiling]),
    revision: profile.revision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

function freezeProvider(value: DeploymentProviderDisclosure): DeploymentProviderDisclosure {
  if (!validText(value.providerId, MAX_ID_BYTES) || !validText(value.modelId, MAX_ID_BYTES) ||
      (value.credentialReadiness !== "ready" && value.credentialReadiness !== "noauth")) {
    throw new TypeError("Provider disclosure is invalid");
  }
  return Object.freeze({
    providerId: value.providerId,
    modelId: value.modelId,
    credentialReadiness: value.credentialReadiness,
  });
}

function fingerprint(scope: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ scope, input }), "utf8").digest("hex");
}

function requestFields(context: TenantCommandContext): void {
  if (!validText(context.accessToken, 8_192) || !validText(context.requestId, MAX_ID_BYTES) ||
      !validText(context.idempotencyKey, MAX_ID_BYTES)) {
    throw new TenantAdministrationError(400, "invalid_profile");
  }
}

function registryRevision(registry: TenantAdministratorRegistry, expected: number): void {
  if (!validPositiveRevision(expected) || registry.revision !== expected) {
    throw new TenantAdministrationError(409, "revision_conflict");
  }
}

function requireAdministrator(
  transaction: TenantAdministrationTransaction,
  context: AuthenticatedSessionContext,
): TenantAdministratorRegistry {
  transaction.requireCurrentSession(context);
  if (transaction.principalKind(context.principal.actorId) !== "human") {
    throw new TenantAdministrationError(403, "human_principal_required");
  }
  const registry = transaction.readAdministratorRegistry();
  if (registry === undefined) {
    throw new TenantAdministrationError(503, "administrator_configuration_unavailable");
  }
  if (!registry.principalIds.includes(context.principal.actorId)) {
    throw new TenantAdministrationError(403, "administrator_required");
  }
  return registry;
}

function validateProfileInput(
  input: Pick<CreateGlobalProfileCommand, "displayName" | "globalResponsibility" |
    "capabilityCeiling" | "toolCeiling">,
  capabilities: ReadonlySet<string>,
  tools: ReadonlySet<string>,
): void {
  if (!validText(input.displayName, MAX_DISPLAY_NAME_BYTES) ||
      !validText(input.globalResponsibility, MAX_RESPONSIBILITY_BYTES) ||
      !exactCanonicalSet(input.capabilityCeiling, capabilities) ||
      !exactCanonicalSet(input.toolCeiling, tools)) {
    throw new TenantAdministrationError(400, "invalid_profile");
  }
}

function immutableAudit(
  options: TenantAdministrationAuthorityOptions,
  action: DeploymentAuditAction,
  actorId: string | null,
  targetId: string,
  revision: number,
  requestId: string,
  occurredAt: string,
): DeploymentAuditRecord {
  return Object.freeze({
    auditId: options.auditIdFactory(), action, actorId, targetId, revision, requestId, occurredAt,
  });
}

function profileMutation(
  options: TenantAdministrationAuthorityOptions,
  eventKind: DeploymentProfileEventKind,
  profile: GlobalAgentProfile,
  previousRevision: number | null,
  occurredAt: string,
): DeploymentProfileMutationRecord {
  return Object.freeze({
    eventId: options.profileEventIdFactory(),
    eventKind,
    profile,
    previousRevision,
    occurredAt,
  });
}

export function createTenantAdministrationAuthority(
  options: TenantAdministrationAuthorityOptions,
): TenantAdministrationAuthority {
  const capabilityRegistry = new Set(options.capabilities);
  const toolRegistry = new Set(options.tools);
  if (capabilityRegistry.size !== options.capabilities.length ||
      toolRegistry.size !== options.tools.length ||
      !options.capabilities.every((value) => validText(value, MAX_ID_BYTES)) ||
      !options.tools.every((value) => validText(value, MAX_ID_BYTES))) {
    throw new TypeError("Tenant administration registries must be closed and unique");
  }
  const clock = options.clock ?? (() => new Date().toISOString());

  function requireProvider(): DeploymentProviderDisclosure {
    return freezeProvider(options.providerDisclosure());
  }

  async function authenticated<TResult>(
    accessToken: string,
    operation: (transaction: TenantAdministrationTransaction,
      context: AuthenticatedSessionContext, registry: TenantAdministratorRegistry) => TResult,
  ): Promise<TResult> {
    if (!validText(accessToken, 8_192)) {
      throw Object.assign(new Error("invalid_token"), { status: 401 });
    }
    const context = await options.sessions.authenticateSession(accessToken);
    return options.repository.transact((transaction) =>
      operation(transaction, context, requireAdministrator(transaction, context)));
  }

  async function idempotent<TResult>(
    scope: string,
    context: TenantCommandContext,
    input: unknown,
    operation: (transaction: TenantAdministrationTransaction,
      session: AuthenticatedSessionContext, registry: TenantAdministratorRegistry,
      occurredAt: string) => TResult,
  ): Promise<TResult> {
    requestFields(context);
    const session = await options.sessions.authenticateSession(context.accessToken);
    const key = `${scope}\0${context.idempotencyKey}`;
    const requestFingerprint = fingerprint(scope, input);
    return options.repository.transact((transaction) => {
      const registry = requireAdministrator(transaction, session);
      const previous = transaction.readReplay(key);
      if (previous !== undefined) {
        if (previous.fingerprint !== requestFingerprint) {
          throw new TenantAdministrationError(409, "idempotency_conflict");
        }
        return previous.result as TResult;
      }
      const occurredAt = clock();
      if (!validTime(occurredAt)) throw new TypeError("Authority clock returned invalid time");
      const result = operation(transaction, session, registry, occurredAt);
      transaction.writeReplay(key, requestFingerprint, result);
      return result;
    });
  }

  function mutateAdministrator(
    action: "add" | "remove",
    context: TenantCommandContext,
    command: TenantAdministratorMutation,
  ): Promise<{ readonly registry: TenantAdministratorRegistry }> {
    return idempotent(`administrator.${action}`, context, command,
      (transaction, session, registry, occurredAt) => {
        if (!validText(command.targetPrincipalId, MAX_ID_BYTES)) {
          throw new TenantAdministrationError(403, "human_principal_required");
        }
        registryRevision(registry, command.expectedRevision);
        if (transaction.principalKind(command.targetPrincipalId) !== "human") {
          throw new TenantAdministrationError(403, "human_principal_required");
        }
        const exists = registry.principalIds.includes(command.targetPrincipalId);
        if (action === "add" && exists) {
          throw new TenantAdministrationError(409, "administrator_already_exists");
        }
        if (action === "remove" && !exists) {
          throw new TenantAdministrationError(404, "administrator_not_found");
        }
        if (action === "remove" && registry.principalIds.length === 1) {
          throw new TenantAdministrationError(409, "last_administrator_required");
        }
        const principalIds = action === "add"
          ? sortedUnique([...registry.principalIds, command.targetPrincipalId])
          : Object.freeze(registry.principalIds.filter((id) => id !== command.targetPrincipalId));
        const next = freezeRegistry({ ...registry, revision: registry.revision + 1,
          principalIds, updatedAt: occurredAt });
        transaction.writeAdministratorRegistry(next);
        transaction.appendAudit(immutableAudit(options, `administrator.${action}`,
          session.principal.actorId, command.targetPrincipalId, next.revision,
          context.requestId, occurredAt));
        return Object.freeze({ registry: next });
      });
  }

  function transitionProfile(
    action: "enable" | "disable",
    context: TenantCommandContext,
    command: TransitionGlobalProfileCommand,
  ): Promise<{ readonly profile: GlobalAgentProfile }> {
    return idempotent(`profile.${action}`, context, command,
      (transaction, session, _registry, occurredAt) => {
        const provider = requireProvider();
        if (!validText(command.profileId, MAX_ID_BYTES) ||
            !validPositiveRevision(command.expectedRevision)) {
          throw new TenantAdministrationError(400, "invalid_profile");
        }
        const current = transaction.readProfile(command.profileId);
        if (current === undefined) throw new TenantAdministrationError(404, "profile_not_found");
        if (current.revision !== command.expectedRevision) {
          throw new TenantAdministrationError(409, "revision_conflict");
        }
        const status = action === "enable" ? "enabled" : "disabled";
        if (current.status === status) {
          throw new TenantAdministrationError(409, "profile_state_conflict");
        }
        const profile = freezeProfile({ ...current, status, revision: current.revision + 1,
          updatedAt: occurredAt });
        transaction.writeProfile(profile, provider.credentialReadiness);
        transaction.appendAudit(immutableAudit(options, `profile.${action}`,
          session.principal.actorId, profile.profileId, profile.revision,
          context.requestId, occurredAt));
        transaction.appendProfileMutation(profileMutation(options, `profile.${action}d`,
          profile, current.revision, occurredAt));
        return Object.freeze({ profile });
      });
  }

  const authority: TenantAdministrationAuthority = {
    async bootstrapFromOwnerConfiguration(input) {
      if (!Array.isArray(input.principalIds) || input.principalIds.length === 0 ||
          !input.principalIds.every((value) => validText(value, MAX_ID_BYTES)) ||
          sortedUnique(input.principalIds).length !== input.principalIds.length ||
          !/^[a-f0-9]{64}$/.test(input.configurationDigest) ||
          Buffer.byteLength(input.configurationDigest, "utf8") > MAX_CONFIGURATION_DIGEST_BYTES) {
        throw new TenantAdministrationError(400, "invalid_bootstrap");
      }
      const principalIds = sortedUnique(input.principalIds);
      return options.repository.transact((transaction) => {
        const existing = transaction.readAdministratorRegistry();
        if (existing !== undefined) {
          // The deployment bootstrap is a one-time root of authority. Later
          // administrator add/remove commands intentionally change the live
          // principal set; a normal restart with the same sealed owner
          // configuration must preserve that newer authoritative state.
          if (existing.configurationDigest === input.configurationDigest) return existing;
          throw new TenantAdministrationError(409, "bootstrap_conflict");
        }
        for (const principalId of principalIds) {
          if (transaction.principalKind(principalId) !== "human") {
            throw new TenantAdministrationError(403, "human_principal_required");
          }
        }
        const occurredAt = clock();
        if (!validTime(occurredAt)) throw new TypeError("Authority clock returned invalid time");
        const registry = freezeRegistry({ revision: 1, principalIds,
          configurationDigest: input.configurationDigest, updatedAt: occurredAt });
        transaction.writeAdministratorRegistry(registry);
        transaction.appendAudit(immutableAudit(options, "administrator.bootstrap", null,
          principalIds.join(","), registry.revision, `bootstrap:${input.configurationDigest}`,
          occurredAt));
        return registry;
      });
    },

    listAdministrators(accessToken) {
      return authenticated(accessToken, (_transaction, _context, registry) => registry);
    },

    addAdministrator(context, command) {
      return mutateAdministrator("add", context, command);
    },

    removeAdministrator(context, command) {
      return mutateAdministrator("remove", context, command);
    },

    queryProfiles(accessToken) {
      return authenticated(accessToken, (transaction) => Object.freeze({
        profiles: Object.freeze(transaction.listProfiles().map(freezeProfile)
          .sort((left, right) => left.profileId.localeCompare(right.profileId))),
        provider: freezeProvider(options.providerDisclosure()),
      }));
    },

    getProfile(accessToken, profileId) {
      if (!validText(profileId, MAX_ID_BYTES)) {
        return Promise.reject(new TenantAdministrationError(400, "invalid_profile"));
      }
      return authenticated(accessToken, (transaction) => {
        const profile = transaction.readProfile(profileId);
        if (profile === undefined) throw new TenantAdministrationError(404, "profile_not_found");
        return Object.freeze({
          profile: freezeProfile(profile),
          provider: freezeProvider(options.providerDisclosure()),
        });
      });
    },

    discloseProvider(accessToken) {
      return authenticated(accessToken, () => freezeProvider(options.providerDisclosure()));
    },

    createProfile(context, command) {
      return idempotent("profile.create", context, command,
        (transaction, session, _registry, occurredAt) => {
          requireProvider();
          if (command.expectedRevision !== 0) {
            throw new TenantAdministrationError(409, "revision_conflict");
          }
          validateProfileInput(command, capabilityRegistry, toolRegistry);
          const profileId = options.profileIdFactory();
          const actorId = options.actorIdFactory();
          if (!validText(profileId, MAX_ID_BYTES) || !validText(actorId, MAX_ID_BYTES)) {
            throw new TypeError("Profile identity factory returned invalid identity");
          }
          transaction.createAgentActor(actorId, command.displayName);
          const profile = freezeProfile({
            profileId, actorId, displayName: command.displayName,
            globalResponsibility: command.globalResponsibility, status: "enabled",
            capabilityCeiling: command.capabilityCeiling, toolCeiling: command.toolCeiling,
            revision: 1, createdAt: occurredAt, updatedAt: occurredAt,
          });
          transaction.writeProfile(profile);
          transaction.appendAudit(immutableAudit(options, "profile.create",
            session.principal.actorId, profile.profileId, profile.revision,
            context.requestId, occurredAt));
          transaction.appendProfileMutation(profileMutation(options, "profile.created",
            profile, null, occurredAt));
          return Object.freeze({ profile });
        });
    },

    updateProfile(context, command) {
      return idempotent("profile.update", context, command,
        (transaction, session, _registry, occurredAt) => {
          const provider = requireProvider();
          if (!validText(command.profileId, MAX_ID_BYTES) ||
              !validPositiveRevision(command.expectedRevision)) {
            throw new TenantAdministrationError(400, "invalid_profile");
          }
          validateProfileInput(command, capabilityRegistry, toolRegistry);
          const current = transaction.readProfile(command.profileId);
          if (current === undefined) throw new TenantAdministrationError(404, "profile_not_found");
          if (current.revision !== command.expectedRevision) {
            throw new TenantAdministrationError(409, "revision_conflict");
          }
          const profile = freezeProfile({ ...current, displayName: command.displayName,
            globalResponsibility: command.globalResponsibility,
            capabilityCeiling: command.capabilityCeiling, toolCeiling: command.toolCeiling,
            revision: current.revision + 1, updatedAt: occurredAt });
          transaction.writeProfile(profile, provider.credentialReadiness);
          transaction.appendAudit(immutableAudit(options, "profile.update",
            session.principal.actorId, profile.profileId, profile.revision,
            context.requestId, occurredAt));
          transaction.appendProfileMutation(profileMutation(options, "profile.updated",
            profile, current.revision, occurredAt));
          return Object.freeze({ profile });
        });
    },

    enableProfile(context, command) {
      return transitionProfile("enable", context, command);
    },

    disableProfile(context, command) {
      return transitionProfile("disable", context, command);
    },

    async rejectUnsupportedCredentialMutation(accessToken): Promise<never> {
      await authenticated(accessToken, () => undefined);
      throw new TenantAdministrationError(503, "configuration_unsupported");
    },
  };
  return Object.freeze(authority);
}
