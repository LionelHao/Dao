import type { AuthenticatedCommandContext, AuthenticatedSessionContext } from "../persistence/contracts.js";
import type {
  DeploymentProviderDisclosure,
  GlobalAgentProfile,
  TenantAdministratorRegistry,
} from "./authority-service.js";

export const TENANT_ADMINISTRATION_OPERATION_VERSION = 1 as const;

export type TenantAdministrationOperation =
  | {
      readonly version: 1;
      readonly type: "tenant-administrator.bootstrap";
      readonly principalIds: readonly string[];
      readonly configurationSha256: string;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "tenant-administrator.list";
      readonly context: AuthenticatedSessionContext;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "tenant-administrator.add" | "tenant-administrator.remove";
      readonly context: AuthenticatedCommandContext;
      readonly targetPrincipalId: string;
      readonly expectedRevision: number;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "agent-profile.list";
      readonly context: AuthenticatedSessionContext;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "agent-profile.get";
      readonly context: AuthenticatedSessionContext;
      readonly profileId: string;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "agent-profile.create";
      readonly context: AuthenticatedCommandContext;
      readonly expectedRevision: 0;
      readonly displayName: string;
      readonly globalResponsibility: string;
      readonly capabilityCeiling: readonly string[];
      readonly toolCeiling: readonly string[];
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "agent-profile.update";
      readonly context: AuthenticatedCommandContext;
      readonly profileId: string;
      readonly expectedRevision: number;
      readonly displayName: string;
      readonly globalResponsibility: string;
      readonly capabilityCeiling: readonly string[];
      readonly toolCeiling: readonly string[];
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "agent-profile.enable" | "agent-profile.disable";
      readonly context: AuthenticatedCommandContext;
      readonly profileId: string;
      readonly expectedRevision: number;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "provider-configuration.disclose" | "provider-configuration.mutate";
      readonly context: AuthenticatedSessionContext;
      readonly now: number;
    };

export type TenantAdministrationResult =
  | { readonly kind: "tenant-administrator-registry"; readonly registry: TenantAdministratorRegistry }
  | { readonly kind: "agent-profile"; readonly profile: GlobalAgentProfile;
      readonly provider: DeploymentProviderDisclosure }
  | { readonly kind: "agent-profiles"; readonly profiles: readonly GlobalAgentProfile[];
      readonly provider: DeploymentProviderDisclosure }
  | { readonly kind: "provider-configuration"; readonly provider: DeploymentProviderDisclosure };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function text(value: unknown, maximum = 200): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum;
}

function revision(value: unknown, allowZero = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0);
}

function context(value: unknown, command: boolean): value is AuthenticatedSessionContext {
  if (!record(value) || !record(value.principal) ||
      !text(value.sessionId) || !text(value.sessionFamilyId) ||
      !text(value.principal.accountId) || !text(value.principal.actorId)) return false;
  const keys = command
    ? ["sessionId", "sessionFamilyId", "principal", "kind", "requestId", "idempotencyKey",
      ...(Object.hasOwn(value, "deviceId") ? ["deviceId"] : [])]
    : ["sessionId", "sessionFamilyId", "principal",
      ...(Object.hasOwn(value, "deviceId") ? ["deviceId"] : [])];
  return exact(value, keys) && exact(value.principal, ["accountId", "actorId"]) &&
    (!Object.hasOwn(value, "deviceId") || text(value.deviceId)) &&
    (!command || (value.kind === "human" && text(value.requestId) && text(value.idempotencyKey)));
}

function canonicalSet(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry, index) =>
    text(entry) && (index === 0 || (value[index - 1] as string).localeCompare(entry) < 0));
}

function canonicalPrincipalIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((id, index) =>
    text(id) && (index === 0 || (value[index - 1] as string).localeCompare(id) < 0));
}

export function isTenantAdministrationOperation(value: unknown): value is TenantAdministrationOperation {
  if (!record(value) || value.version !== 1 || typeof value.type !== "string" ||
      !revision(value.now, true)) return false;
  switch (value.type) {
    case "tenant-administrator.bootstrap":
      return exact(value, ["version", "type", "principalIds", "configurationSha256", "now"]) &&
        canonicalPrincipalIds(value.principalIds) &&
        typeof value.configurationSha256 === "string" && /^[a-f0-9]{64}$/.test(value.configurationSha256);
    case "tenant-administrator.list":
    case "agent-profile.list":
    case "provider-configuration.disclose":
    case "provider-configuration.mutate":
      return exact(value, ["version", "type", "context", "now"]) && context(value.context, false);
    case "tenant-administrator.add":
    case "tenant-administrator.remove":
      return exact(value, ["version", "type", "context", "targetPrincipalId", "expectedRevision", "now"]) &&
        context(value.context, true) && text(value.targetPrincipalId) && revision(value.expectedRevision);
    case "agent-profile.get":
      return exact(value, ["version", "type", "context", "profileId", "now"]) &&
        context(value.context, false) && text(value.profileId);
    case "agent-profile.create":
      return exact(value, ["version", "type", "context", "expectedRevision", "displayName",
        "globalResponsibility", "capabilityCeiling", "toolCeiling", "now"]) &&
        context(value.context, true) && value.expectedRevision === 0 && text(value.displayName, 120) &&
        text(value.globalResponsibility, 4_000) && canonicalSet(value.capabilityCeiling) &&
        canonicalSet(value.toolCeiling);
    case "agent-profile.update":
      return exact(value, ["version", "type", "context", "profileId", "expectedRevision",
        "displayName", "globalResponsibility", "capabilityCeiling", "toolCeiling", "now"]) &&
        context(value.context, true) && text(value.profileId) && revision(value.expectedRevision) &&
        text(value.displayName, 120) && text(value.globalResponsibility, 4_000) &&
        canonicalSet(value.capabilityCeiling) && canonicalSet(value.toolCeiling);
    case "agent-profile.enable":
    case "agent-profile.disable":
      return exact(value, ["version", "type", "context", "profileId", "expectedRevision", "now"]) &&
        context(value.context, true) && text(value.profileId) && revision(value.expectedRevision);
    default:
      return false;
  }
}

function provider(value: unknown): value is DeploymentProviderDisclosure {
  return record(value) && exact(value, ["providerId", "modelId", "credentialReadiness"]) &&
    text(value.providerId) && text(value.modelId) &&
    (value.credentialReadiness === "ready" || value.credentialReadiness === "noauth");
}

function registry(value: unknown): value is TenantAdministratorRegistry {
  return record(value) && exact(value, ["revision", "principalIds", "configurationDigest", "updatedAt"]) &&
    revision(value.revision) && canonicalPrincipalIds(value.principalIds) &&
    typeof value.configurationDigest === "string" && /^[a-f0-9]{64}$/.test(value.configurationDigest) &&
    typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt));
}

function profile(value: unknown): value is GlobalAgentProfile {
  return record(value) && exact(value, ["profileId", "actorId", "displayName",
    "globalResponsibility", "status", "capabilityCeiling", "toolCeiling", "revision",
    "createdAt", "updatedAt"]) && text(value.profileId) && text(value.actorId) &&
    text(value.displayName, 120) && text(value.globalResponsibility, 4_000) &&
    (value.status === "enabled" || value.status === "disabled") &&
    canonicalSet(value.capabilityCeiling) && canonicalSet(value.toolCeiling) &&
    revision(value.revision) && typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) && typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt));
}

export function isTenantAdministrationResult(value: unknown): value is TenantAdministrationResult {
  if (!record(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "tenant-administrator-registry":
      return exact(value, ["kind", "registry"]) && registry(value.registry);
    case "agent-profile":
      return exact(value, ["kind", "profile", "provider"]) && profile(value.profile) && provider(value.provider);
    case "agent-profiles":
      return exact(value, ["kind", "profiles", "provider"]) && Array.isArray(value.profiles) &&
        value.profiles.every(profile) && provider(value.provider);
    case "provider-configuration":
      return exact(value, ["kind", "provider"]) && provider(value.provider);
    default:
      return false;
  }
}
