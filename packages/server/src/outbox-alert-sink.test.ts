import { describe, expect, it, vi } from "vitest";
import {
  createOutboxAlertController,
  type OutboxStructuredAlert,
} from "./outbox-alert-sink.js";

describe("outbox structured alerts", () => {
  it("emits backlog warning at 60s and critical at 5m exactly once", async () => {
    const alerts: OutboxStructuredAlert[] = [];
    const controller = createOutboxAlertController({
      sink: { emit: (alert) => { alerts.push(alert); } },
    });
    const delivery = {
      family: "central" as const,
      deliveryId: "delivery-1",
      eventId: "event-1",
      occurredAtMs: 1_000,
      attempts: 2,
    };

    await controller.observeBacklog(delivery, 60_999);
    expect(alerts).toEqual([]);
    await controller.observeBacklog(delivery, 61_000);
    await controller.observeBacklog(delivery, 62_000);
    await controller.observeBacklog(delivery, 301_000);
    await controller.observeBacklog(delivery, 400_000);

    expect(alerts).toEqual([
      { severity: "warning", code: "outbox_backlog_warning", family: "central",
        deliveryId: "delivery-1", eventId: "event-1", attempts: 2, ageMs: 60_000 },
      { severity: "critical", code: "outbox_backlog_critical", family: "central",
        deliveryId: "delivery-1", eventId: "event-1", attempts: 2, ageMs: 300_000 },
    ]);
  });

  it("reports dead-letter and dispatcher failures with closed metadata only", async () => {
    const emit = vi.fn();
    const controller = createOutboxAlertController({ sink: { emit } });

    await controller.deadLetter({ family: "deployment-profile", deliveryId: "delivery-2",
      eventId: "event-2", attempts: 8, ageMs: 500_000, reason: "send_rejected" });
    await controller.dispatcherFailure("storage_unavailable");

    expect(emit).toHaveBeenNthCalledWith(1, {
      severity: "critical", code: "outbox_delivery_dead_lettered",
      family: "deployment-profile", deliveryId: "delivery-2", eventId: "event-2",
      attempts: 8, ageMs: 500_000, reason: "send_rejected",
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      severity: "critical", code: "outbox_dispatcher_failure",
      family: "central", reason: "storage_unavailable",
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("payload");
  });
});
