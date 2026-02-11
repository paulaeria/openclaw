import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ModelChangeReason } from "./model-change-tracking.js";
import { log } from "./pi-embedded-runner/logger.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_THRESHOLD = 25; // Default auto-reset threshold

export class CopilotInitiatorTracker {
  #firstCallMade = new Set<string>();
  #sessionTimestamps = new Map<string, number>();
  #agentMessageCount = new Map<string, number>();
  #parentSessionMap = new Map<string, string>(); // child → parent mapping
  // Track which sessions have directly made calls (not inherited from parent)
  #directCalls = new Set<string>();

  /**
   * Register a child session with its parent for Copilot tracking.
   * Child sessions will use the parent's sessionId for X-Initiator logic.
   *
   * NOTE: Does not add child to #firstCallMade here. The child will be added
   * when it makes its first call (which will check the parent's #directCalls status).
   *
   * @param childSessionId - The child's session ID
   * @param parentSessionId - The parent's session ID to track against
   */
  registerChildSession(childSessionId: string, parentSessionId: string): void {
    this.#parentSessionMap.set(childSessionId, parentSessionId);
    log.debug(
      `copilot x-initiator: registered child session (child=${childSessionId}, parent=${parentSessionId})`,
    );
  }

  /**
   * Get the effective session ID for Copilot tracking.
   * Returns the parent session ID if this is a registered child session.
   *
   * @param sessionId - The session ID to resolve
   * @returns The effective session ID (parent or self)
   */
  #getEffectiveSessionId(sessionId: string): string {
    return this.#parentSessionMap.get(sessionId) ?? sessionId;
  }

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
    // Resolve to parent session for tracking if registered
    const effectiveSessionId = this.#getEffectiveSessionId(sessionId);

    // Determine threshold: session override > global config > default (50)
    // threshold = 0 means auto-reset is disabled
    const threshold = sessionThreshold ?? globalThreshold ?? DEFAULT_THRESHOLD;

    if (this.#firstCallMade.has(effectiveSessionId)) {
      // Increment agent message count
      const count = (this.#agentMessageCount.get(effectiveSessionId) ?? 0) + 1;
      this.#agentMessageCount.set(effectiveSessionId, count);

      // Auto-reset if threshold is enabled ( > 0) AND reached
      if (threshold > 0 && count >= threshold) {
        log.debug(
          `copilot x-initiator: auto-reset after ${count} agent messages (sessionId=${sessionId}, effective=${effectiveSessionId})`,
        );
        this.#agentMessageCount.set(effectiveSessionId, 0);
        return "user";
      }

      return "agent";
    }

    // Check if this is a child whose parent has made a direct call
    // If so, add to #firstCallMade so subsequent calls continue parent's session
    if (sessionId !== effectiveSessionId && this.#directCalls.has(effectiveSessionId)) {
      this.#firstCallMade.add(effectiveSessionId);
      this.#sessionTimestamps.set(effectiveSessionId, Date.now());
      this.#agentMessageCount.set(effectiveSessionId, 0);
      // Continue with incrementing count (not a first call for the user)
      const count = 1;
      this.#agentMessageCount.set(effectiveSessionId, count);
      return "agent";
    }

    // First call - initialize tracking with effective session ID
    this.#firstCallMade.add(effectiveSessionId);
    this.#sessionTimestamps.set(effectiveSessionId, Date.now());
    this.#agentMessageCount.set(effectiveSessionId, 0);
    // Mark this session as having made a direct call
    this.#directCalls.add(effectiveSessionId);
    return "user";
  }

  /**
   * Reset all tracking for a session (called on /new, /reset, user model changes).
   * Resets both the session and its effective (parent) session.
   */
  reset(sessionId: string): void {
    const effectiveSessionId = this.#getEffectiveSessionId(sessionId);
    this.#firstCallMade.delete(effectiveSessionId);
    this.#sessionTimestamps.delete(effectiveSessionId);
    this.#agentMessageCount.delete(effectiveSessionId);
    this.#directCalls.delete(effectiveSessionId);
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
   * Also cleans up orphaned parent session mappings.
   */
  cleanup(): void {
    const now = Date.now();

    // Clean up parent mappings for stale sessions
    for (const [child, parent] of this.#parentSessionMap) {
      const timestamp = this.#sessionTimestamps.get(parent);
      if (timestamp && now - timestamp > CLEANUP_INTERVAL_MS) {
        this.#parentSessionMap.delete(child);
      }
    }

    // Clean up stale session data
    for (const [sessionId, timestamp] of this.#sessionTimestamps) {
      if (now - timestamp > CLEANUP_INTERVAL_MS) {
        this.#firstCallMade.delete(sessionId);
        this.#sessionTimestamps.delete(sessionId);
        this.#agentMessageCount.delete(sessionId);
        this.#directCalls.delete(sessionId);
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
    /** Parent session ID for X-Initiator tracking (subagents inherit parent's quota state) */
    copilotParentSessionId?: string;
    /** Share parent session ID for X-Initiator tracking (default: true) */
    shareSessionId?: boolean;
  },
): StreamFn {
  // Register child session with parent if sharing is enabled
  if (
    provider === "github-copilot" &&
    config?.shareSessionId !== false &&
    config?.copilotParentSessionId
  ) {
    tracker.registerChildSession(sessionId, config.copilotParentSessionId);
  }

  return async function streamWithInitiatorHeader(model, context, options) {
    const headers = { ...options?.headers };

    if (provider === "github-copilot" && !config?.disableInitiatorHeader) {
      const sessionThreshold = config?.sessionEntry?.copilotThreshold;
      const globalThreshold = config?.agentMessageResetThreshold;
      const initiator = tracker.getInitiator(sessionId, sessionThreshold, globalThreshold);
      headers["X-Initiator"] = initiator;
    }

    return originalStreamSimple(model, context, { ...options, headers });
  };
}

export const copilotInitiatorTracker = new CopilotInitiatorTracker();
