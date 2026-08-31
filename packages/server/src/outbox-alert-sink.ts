import type { OutboxDeliveryFailureReason } from "./persistence/contracts.js";

export type AuthoritativeOutboxFamily =
  | "central"
  | "deployment-profile"
  | "project-shadow"
  | "room-cache-invalidation";

export type OutboxStructuredAlert =
  | Readonly<{
      severity: "warning" | "critical";
      code: "outbox_backlog_warning" | "outbox_backlog_critical";
      family: AuthoritativeOutboxFamily;
      deliveryId: string;
      eventId: string;
      attempts: number;
      ageMs: number;
    }>
  | Readonly<{
      severity: "critical";
      code: "outbox_delivery_dead_lettered";
      family: AuthoritativeOutboxFamily;
      deliveryId: string;
      eventId: string;
      attempts: number;
      ageMs: number;
      reason: OutboxDeliveryFailureReason;
    }>
  | Readonly<{
      severity: "critical";
      code: "outbox_dispatcher_failure";
      family: "central";
      reason: "storage_unavailable" | "shutdown_timeout";
    }>;

export interface OutboxAlertSink {
  emit(alert: OutboxStructuredAlert): Promise<void> | void;
}

export interface OutboxAlertController {
  observeBacklog(input: Readonly<{
    family: AuthoritativeOutboxFamily;
    deliveryId: string;
    eventId: string;
    occurredAtMs: number;
    attempts: number;
  }>, nowMs: number): Promise<void>;
  deadLetter(input: Readonly<{
    family: AuthoritativeOutboxFamily;
    deliveryId: string;
    eventId: string;
    attempts: number;
    ageMs: number;
    reason: OutboxDeliveryFailureReason;
  }>): Promise<void>;
  dispatcherFailure(reason: "storage_unavailable" | "shutdown_timeout"): Promise<void>;
  settled(family: AuthoritativeOutboxFamily, deliveryId: string): void;
}

export const OUTBOX_BACKLOG_WARNING_MS = 60_000;
export const OUTBOX_BACKLOG_CRITICAL_MS = 5 * 60_000;

function trackingKey(family: AuthoritativeOutboxFamily, deliveryId: string): string {
  return `${family}\0${deliveryId}`;
}

export function createOutboxAlertController(options: Readonly<{
  sink: OutboxAlertSink;
}>): OutboxAlertController {
  const warned = new Set<string>();
  const critical = new Set<string>();
  return Object.freeze({
    async observeBacklog(input: Readonly<{
      family: AuthoritativeOutboxFamily;
      deliveryId: string;
      eventId: string;
      occurredAtMs: number;
      attempts: number;
    }>, nowMs: number) {
      if (!Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0 ||
          !Number.isSafeInteger(nowMs) || nowMs < input.occurredAtMs ||
          !Number.isSafeInteger(input.attempts) || input.attempts < 0) {
        throw new RangeError("outbox backlog observation is invalid");
      }
      const ageMs = nowMs - input.occurredAtMs;
      const key = trackingKey(input.family, input.deliveryId);
      if (ageMs >= OUTBOX_BACKLOG_WARNING_MS && !warned.has(key)) {
        warned.add(key);
        await options.sink.emit(Object.freeze({
          severity: "warning",
          code: "outbox_backlog_warning",
          family: input.family,
          deliveryId: input.deliveryId,
          eventId: input.eventId,
          attempts: input.attempts,
          ageMs,
        }));
      }
      if (ageMs >= OUTBOX_BACKLOG_CRITICAL_MS && !critical.has(key)) {
        critical.add(key);
        await options.sink.emit(Object.freeze({
          severity: "critical",
          code: "outbox_backlog_critical",
          family: input.family,
          deliveryId: input.deliveryId,
          eventId: input.eventId,
          attempts: input.attempts,
          ageMs,
        }));
      }
    },
    async deadLetter(input: Readonly<{
      family: AuthoritativeOutboxFamily;
      deliveryId: string;
      eventId: string;
      attempts: number;
      ageMs: number;
      reason: OutboxDeliveryFailureReason;
    }>) {
      await options.sink.emit(Object.freeze({
        severity: "critical",
        code: "outbox_delivery_dead_lettered",
        ...input,
      }));
    },
    async dispatcherFailure(reason: "storage_unavailable" | "shutdown_timeout") {
      await options.sink.emit(Object.freeze({
        severity: "critical",
        code: "outbox_dispatcher_failure",
        family: "central",
        reason,
      }));
    },
    settled(family: AuthoritativeOutboxFamily, deliveryId: string) {
      const key = trackingKey(family, deliveryId);
      warned.delete(key);
      critical.delete(key);
    },
  });
}
