import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CopilotInitiatorTracker } from "./copilot-initiator-header.js";

describe("CopilotInitiatorTracker - parent session sharing", () => {
  let tracker: CopilotInitiatorTracker;

  beforeEach(() => {
    tracker = new CopilotInitiatorTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should use parent session state for child calls", () => {
    // Parent makes first call
    expect(tracker.getInitiator("parent-123")).toBe("user");
    expect(tracker.getInitiator("parent-123")).toBe("agent");

    // Register child
    tracker.registerChildSession("child-456", "parent-123");

    // Child uses parent's state
    expect(tracker.getInitiator("child-456")).toBe("agent");
  });

  it("should not increment counter on child registration", () => {
    tracker.getInitiator("parent-123"); // user
    tracker.getInitiator("parent-123"); // agent (count = 1)

    tracker.registerChildSession("child-456", "parent-123");

    // Counter should still be 1
    expect(tracker.getInitiator("parent-123")).toBe("agent");
  });

  it("should share threshold across parent and child", () => {
    const threshold = 3;

    expect(tracker.getInitiator("parent-123", threshold)).toBe("user");
    expect(tracker.getInitiator("parent-123", threshold)).toBe("agent"); // count=1
    expect(tracker.getInitiator("parent-123", threshold)).toBe("agent"); // count=2

    tracker.registerChildSession("child-456", "parent-123");
    expect(tracker.getInitiator("child-456", threshold)).toBe("user"); // count=3, reset!

    // After reset, count starts over
    expect(tracker.getInitiator("parent-123", threshold)).toBe("agent"); // count=1
  });

  it("should allow multiple children to share same parent", () => {
    tracker.getInitiator("parent-123"); // user
    tracker.getInitiator("parent-123"); // agent (count = 1)

    tracker.registerChildSession("child-1", "parent-123");
    tracker.registerChildSession("child-2", "parent-123");

    expect(tracker.getInitiator("child-1")).toBe("agent"); // count = 2
    expect(tracker.getInitiator("child-2")).toBe("agent"); // count = 3
  });

  it("should handle nested children (direct mapping, no transitive traversal)", () => {
    tracker.getInitiator("grandparent-abc"); // user
    tracker.getInitiator("grandparent-abc"); // agent

    tracker.registerChildSession("parent-123", "grandparent-abc");
    tracker.registerChildSession("child-456", "parent-123");

    // Child maps directly to parent-123, not grandparent
    // parent-123 hasn't made a call, so child-456's first call is "user"
    expect(tracker.getInitiator("child-456")).toBe("user");
  });

  it("should reset effective (parent) session when child is reset", () => {
    tracker.getInitiator("parent-123"); // user
    tracker.getInitiator("parent-123"); // agent

    tracker.registerChildSession("child-456", "parent-123");

    // Reset child - should reset parent state
    tracker.reset("child-456");

    // Next call from child should be "user" again
    expect(tracker.getInitiator("child-456")).toBe("user");
  });

  it("should work with cleanup of orphaned parent mappings", () => {
    tracker.getInitiator("parent-123"); // user, timestamp = now
    tracker.registerChildSession("child-456", "parent-123");

    // Advance time past cleanup interval
    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours

    tracker.cleanup();

    // Child mapping should be cleaned up
    // Next call treats child as new session
    expect(tracker.getInitiator("child-456")).toBe("user");
  });

  it("should handle child with no parent as independent session", () => {
    tracker.getInitiator("parent-123"); // user
    tracker.getInitiator("parent-123"); // agent

    // Child not registered - behaves independently
    expect(tracker.getInitiator("child-456")).toBe("user");
    expect(tracker.getInitiator("child-456")).toBe("agent");
  });

  it("should support threshold=0 (disabled) with shared sessions", () => {
    tracker.getInitiator("parent-123", 0); // user
    tracker.getInitiator("parent-123", 0); // agent

    tracker.registerChildSession("child-456", "parent-123");

    // Even with many calls, no auto-reset when threshold=0
    expect(tracker.getInitiator("child-456", 0)).toBe("agent");
    expect(tracker.getInitiator("parent-123", 0)).toBe("agent");
    expect(tracker.getInitiator("child-456", 0)).toBe("agent");
  });
});
