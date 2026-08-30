import { describe, expect, it } from "vitest";
import { createDispatchOnceLatch } from "./dispatch-once-latch.js";

describe("process-local dispatch once latch", () => {
  it("reserves bounded claims and permanently remembers entered dispatches", () => {
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
