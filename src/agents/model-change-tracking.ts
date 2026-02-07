/**
 * Model change tracking for GitHub Copilot X-Initiator header optimization.
 *
 * When users explicitly change models (via /model, UI picker, inline selection),
 * we reset the X-Initiator header to "user" to treat it as a fresh conversation.
 * Automatic changes (failover, config defaults) do NOT reset the tracker.
 */

/**
 * The reason why a model was changed.
 */
export type ModelChangeReason =
  | "user-command" // User explicitly changed model (CLI command, UI picker, inline selection)
  | "failover" // Automatic retry with different model
  | "config-default" // Default model from config applied
  | "session-override" // Per-session override applied automatically
  | "unknown"; // Fallback for unclear cases

/**
 * Event representing a model change.
 */
export type ModelChangeEvent = {
  sessionId: string;
  reason: ModelChangeReason;
  provider: string;
  model: string;
  previousProvider?: string;
  previousModel?: string;
};
