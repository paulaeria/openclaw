import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { CopilotInitiatorTracker, createCopilotAwareStream } from "./copilot-initiator-header.js";

describe("createCopilotAwareStream with config", () => {
  it("should not inject X-Initiator header when disableInitiatorHeader is true", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "test-session-disabled";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStream: StreamFn = vi.fn().mockImplementation(async (_model, _context, options) => {
      capturedHeaders = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });

    const wrappedStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStream,
      { disableInitiatorHeader: true },
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    await wrappedStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBeUndefined();
  });

  it("should inject X-Initiator header when disableInitiatorHeader is false", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "test-session-enabled";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStream: StreamFn = vi.fn().mockImplementation(async (_model, _context, options) => {
      capturedHeaders = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });

    const wrappedStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStream,
      { disableInitiatorHeader: false },
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    await wrappedStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBe("user");
  });

  it("should inject X-Initiator header when config is undefined (default behavior)", async () => {
    const tracker = new CopilotInitiatorTracker();
    const sessionId = "test-session-default";

    let capturedHeaders: Record<string, string> | undefined;
    const mockStream: StreamFn = vi.fn().mockImplementation(async (_model, _context, options) => {
      capturedHeaders = options?.headers as Record<string, string> | undefined;
      return new AssistantMessageEventStream();
    });

    const wrappedStream = createCopilotAwareStream(
      "github-copilot",
      sessionId,
      tracker,
      mockStream,
      undefined,
    );

    const model = {
      api: "openai-completions",
      provider: "github-copilot",
      id: "gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    await wrappedStream(model, context, {});

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.["X-Initiator"]).toBe("user");
  });
});
