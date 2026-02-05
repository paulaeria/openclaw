import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  CopilotInitiatorTracker,
  createCopilotAwareStream,
} from "../../copilot-initiator-header.js";

describe("pi-embedded-runner Copilot X-Initiator integration", () => {
  it("should wrap streamSimple and inject X-Initiator header for github-copilot provider", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "integration-test-session-1";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStreamSimple: StreamFn = vi
      .fn()
      .mockImplementation(async (_model, _context, options) => {
        capturedHeaders = options?.headers as Record<string, string> | undefined;
        return new AssistantMessageEventStream();
      });

    // Simulate what runEmbeddedAttempt should do: wrap streamSimple before use
    const copilotAwareStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStreamSimple,
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    const options: SimpleStreamOptions = {};

    // First call should have X-Initiator: user
    await copilotAwareStream(model, context, options);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBe("user");
    expect(mockStreamSimple).toHaveBeenCalledTimes(1);
  });

  it("should correctly track initiator across multiple calls for github-copilot", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "integration-test-session-2";

    const mockStreamSimple: StreamFn = vi.fn().mockResolvedValue(new AssistantMessageEventStream());

    const copilotAwareStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStreamSimple,
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    // First call - user initiator
    await copilotAwareStream(model, context, {});

    // Second call - agent initiator
    let capturedHeaders: Record<string, string> | undefined;
    vi.mocked(mockStreamSimple).mockImplementationOnce(async (_model, _context, options) => {
      capturedHeaders = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });

    await copilotAwareStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBe("agent");
    expect(mockStreamSimple).toHaveBeenCalledTimes(2);
  });

  it("should not inject X-Initiator header for non-Copilot providers", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "integration-test-session-3";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStreamSimple: StreamFn = vi
      .fn()
      .mockImplementation(async (_model, _context, options) => {
        capturedHeaders = options?.headers as Record<string, string> | undefined;
        return new AssistantMessageEventStream();
      });

    // For anthropic provider, X-Initiator should not be added
    const copilotAwareStream = createCopilotAwareStream(
      "anthropic",
      sessionId,
      tracker,
      mockStreamSimple,
    );

    const model = {
      api: "anthropic-completions",
      provider: "anthropic",
      id: "claude-3-5-sonnet",
    } as Model<"anthropic-completions">;
    const context: Context = { messages: [] };

    await copilotAwareStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBeUndefined();
    expect(mockStreamSimple).toHaveBeenCalledTimes(1);
  });

  it("should preserve existing headers while adding X-Initiator", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "integration-test-session-4";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStreamSimple: StreamFn = vi
      .fn()
      .mockImplementation(async (_model, _context, options) => {
        capturedHeaders = options?.headers as Record<string, string> | undefined;
        return new AssistantMessageEventStream();
      });

    const copilotAwareStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStreamSimple,
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    const existingHeaders = { "X-Custom-Header": "custom-value" };
    await copilotAwareStream(model, context, { headers: existingHeaders });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBe("user");
    expect(capturedHeaders?.["X-Custom-Header"]).toBe("custom-value");
    expect(mockStreamSimple).toHaveBeenCalledTimes(1);
  });

  it("should handle multiple sessions independently", async () => {
    const tracker = new CopilotInitiatorTracker();
    const session1 = "integration-session-1";
    const session2 = "integration-session-2";

    const mockStreamSimple: StreamFn = vi.fn().mockResolvedValue(new AssistantMessageEventStream());

    const copilotAwareStream1 = createCopilotAwareStream(
      "github-copilot",
      session1,
      tracker,
      mockStreamSimple,
    );

    const copilotAwareStream2 = createCopilotAwareStream(
      "github-copilot",
      session2,
      tracker,
      mockStreamSimple,
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    // First call for session 1 - should be "user"
    let capturedHeaders1: Record<string, string> | undefined;
    vi.mocked(mockStreamSimple).mockImplementationOnce(async (_model, _context, options) => {
      capturedHeaders1 = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });
    await copilotAwareStream1(model, context, {});

    // First call for session 2 - should also be "user"
    let capturedHeaders2: Record<string, string> | undefined;
    vi.mocked(mockStreamSimple).mockImplementationOnce(async (_model, _context, options) => {
      capturedHeaders2 = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });
    await copilotAwareStream2(model, context, {});

    expect(capturedHeaders1?.["X-Initiator"]).toBe("user");
    expect(capturedHeaders2?.["X-Initiator"]).toBe("user");

    // Second call for session 1 - should be "agent"
    let capturedHeaders3: Record<string, string> | undefined;
    vi.mocked(mockStreamSimple).mockImplementationOnce(async (_model, _context, options) => {
      capturedHeaders3 = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });
    await copilotAwareStream1(model, context, {});

    expect(capturedHeaders3?.["X-Initiator"]).toBe("agent");
  });
});
