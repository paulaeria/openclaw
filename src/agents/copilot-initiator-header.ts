import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ModelChangeReason } from "./model-change-tracking.js";
import { log } from "./pi-embedded-runner/logger.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_THRESHOLD = 25; // Default auto-reset threshold

export class CopilotInitiatorTracker {
  #firstCallMade = new Set<string>();
  #sessionTimestamps = new Map<string, number>();
  #agentMessageCount = new Map<string, number>();

  /**
   * Get the X-Initiator value for a session.
   *
   * @param sessionId - Session identifier
   * @param sessionThreshold - Per-session threshold override (0 = disabled)
   * @param globalThreshold - Global config threshold (defaults to 50)
   * @returns "user" for first call or after threshold, "agent" otherwise
   */
  getInitiator(
    sessionId: string,
    sessionThreshold?: number,
    globalThreshold?: number,
  ): "user" | "agent" {
    // Determine threshold: session override > global config > default (50)
    // threshold = 0 means auto-reset is disabled
    const threshold = sessionThreshold ?? globalThreshold ?? DEFAULT_THRESHOLD;

    if (this.#firstCallMade.has(sessionId)) {
      // Increment agent message count
      const count = (this.#agentMessageCount.get(sessionId) ?? 0) + 1;
      this.#agentMessageCount.set(sessionId, count);

      // Auto-reset if threshold is enabled ( > 0) AND reached
      if (threshold > 0 && count >= threshold) {
        log.debug(
          `copilot x-initiator: auto-reset after ${count} agent messages (sessionId=${sessionId})`,
        );
        this.#agentMessageCount.set(sessionId, 0);
        return "user";
      }

      return "agent";
    }

    // First call - initialize tracking
    this.#firstCallMade.add(sessionId);
    this.#sessionTimestamps.set(sessionId, Date.now());
    this.#agentMessageCount.set(sessionId, 0);
    return "user";
  }

  /**
   * Reset all tracking for a session (called on /new, /reset, user model changes).
   */
  reset(sessionId: string): void {
    this.#firstCallMade.delete(sessionId);
    this.#sessionTimestamps.delete(sessionId);
    this.#agentMessageCount.delete(sessionId);
  }

  /**
   * Handle model changes. Only resets tracker for user-initiated changes.
   */
  onModelChanged(sessionId: string, reason: ModelChangeReason): void {
    if (reason === "user-command") {
      this.reset(sessionId);
      log.debug(`copilot x-initiator: reset on user model change (sessionId=${sessionId})`);
    }
  }

  /**
   * Clean up stale session data (older than 24 hours).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [sessionId, timestamp] of this.#sessionTimestamps) {
      if (now - timestamp > CLEANUP_INTERVAL_MS) {
        this.#firstCallMade.delete(sessionId);
        this.#sessionTimestamps.delete(sessionId);
        this.#agentMessageCount.delete(sessionId);
      }
    }
  }
}

export function createCopilotAwareStream(
  provider: string,
  sessionId: string,
  tracker: CopilotInitiatorTracker,
  originalStreamSimple: StreamFn,
  config?: {
    disableInitiatorHeader?: boolean;
    agentMessageResetThreshold?: number;
    sessionEntry?: { copilotThreshold?: number };
  },
): StreamFn {
  return async function streamWithInitiatorHeader(model, context, options) {
    const headers = { ...options?.headers };

    if (provider === "github-copilot" && !config?.disableInitiatorHeader) {
      const sessionThreshold = config?.sessionEntry?.copilotThreshold;
      const globalThreshold = config?.agentMessageResetThreshold;
      const initiator = tracker.getInitiator(sessionId, sessionThreshold, globalThreshold);
      headers["X-Initiator"] = initiator;
      log.debug(`copilot x-initiator: sessionId=${sessionId} initiator=${initiator}`);
    }

    return originalStreamSimple(model, context, { ...options, headers });
  };
}

export const copilotInitiatorTracker = new CopilotInitiatorTracker();
