import { describe, expect, it } from "vitest";
import { createDispatchOnceLatch } from "./dispatch-once-latch.js";

describe("process-local dispatch once latch", () => {
  it("reserves bounded claims and releases an entered dispatch only after terminal settlement", () => {
    const latch = createDispatchOnceLatch({ capacity: 2 });
    const first = latch.reserve();
    const second = latch.reserve();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(latch.reserve()).toBeUndefined();

    expect(latch.enter(first!, "dispatch-1")).toBe(true);
    expect(latch.enter(second!, "dispatch-1")).toBe(false);
    expect(latch.state("dispatch-1")).toBe("entered");
    expect(latch.reserve()).toBeDefined();
    expect(latch.settle("dispatch-1")).toBe(true);
    expect(latch.state("dispatch-1")).toBeUndefined();
  });

  it("retains an ambiguous claim slot so throw/abort cannot open a replay lane", () => {
    const latch = createDispatchOnceLatch({ capacity: 1 });
    const reservation = latch.reserve();
    expect(reservation).toBeDefined();
    latch.retainUnknown(reservation!);
    expect(latch.reserve()).toBeUndefined();
    expect(latch.settle("missing-dispatch")).toBe(false);
  });

  it("releases rejected claim reservations but closes permanently on shutdown", () => {
    const latch = createDispatchOnceLatch({ capacity: 1 });
    const reservation = latch.reserve();
    expect(reservation).toBeDefined();
    latch.release(reservation!);
    expect(latch.reserve()).toBeDefined();
    latch.close();
    expect(latch.reserve()).toBeUndefined();
  });

  it("lets a claim reserved before shutdown cross the committed-claim boundary", () => {
    const latch = createDispatchOnceLatch({ capacity: 1 });
    const reservation = latch.reserve();
    latch.close();
    expect(latch.enter(reservation!, "dispatch-committed-during-shutdown")).toBe(true);
    expect(latch.reserve()).toBeUndefined();
  });
});
