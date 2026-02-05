import type { StreamFn } from "@mariozechner/pi-agent-core";
import { log } from "./pi-embedded-runner/logger.js";

export class CopilotInitiatorTracker {
  #firstCallMade = new Set<string>();

  getInitiator(sessionId: string): "user" | "agent" {
    if (this.#firstCallMade.has(sessionId)) {
      return "agent";
    }
    this.#firstCallMade.add(sessionId);
    return "user";
  }

  reset(sessionId: string): void {
    this.#firstCallMade.delete(sessionId);
  }
}

export function createCopilotAwareStream(
  provider: string,
  sessionId: string,
  tracker: CopilotInitiatorTracker,
  originalStreamSimple: StreamFn,
  config?: { disableInitiatorHeader?: boolean },
): StreamFn {
  return async function streamWithInitiatorHeader(model, context, options) {
    const headers = { ...options?.headers };

    if (provider === "github-copilot" && !config?.disableInitiatorHeader) {
      const initiator = tracker.getInitiator(sessionId);
      headers["X-Initiator"] = initiator;
      log.debug(`copilot x-initiator: sessionId=${sessionId} initiator=${initiator}`);
    }

    return originalStreamSimple(model, context, { ...options, headers });
  };
}

export const copilotInitiatorTracker = new CopilotInitiatorTracker();
