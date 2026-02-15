import type { CommandHandler } from "./commands-types.js";
import { updateSessionStore } from "../../config/sessions.js";

/**
 * Parse /copilot-threshold command.
 * Returns null if not a match.
 */
function parseCopilotThresholdCommand(commandBody: string): {
  hasCommand: boolean;
  action: "enable" | "disable" | "number" | null;
  value?: number;
} | null {
  const match = commandBody.match(/^\/copilot-threshold\s*(enable|disable|\d+)?$/i);
  if (!match) {
    return { hasCommand: false, action: null };
  }

  const arg = match[1];

  if (!arg) {
    return { hasCommand: true, action: null }; // Show status
  }

  if (arg.toLowerCase() === "enable") {
    return { hasCommand: true, action: "enable", value: 50 }; // Default to 50
  }

  if (arg.toLowerCase() === "disable") {
    return { hasCommand: true, action: "disable", value: 0 };
  }

  const num = parseInt(arg, 10);
  if (!isNaN(num)) {
    return { hasCommand: true, action: "number", value: num };
  }

  return { hasCommand: false, action: null };
}

/**
 * Handle /copilot-threshold command.
 *
 * Usage:
 *   /copilot-threshold              → Show status
 *   /copilot-threshold enable       → Enable with default (50)
 *   /copilot-threshold disable      → Disable auto-reset
 *   /copilot-threshold <number>     → Set threshold
 */
export const handleCopilotThresholdCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseCopilotThresholdCommand(params.command.commandBodyNormalized);
  if (!parsed || !parsed.hasCommand) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ You're not authorized to use this command." },
    };
  }

  if (!params.sessionEntry || !params.sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No active session for this command." },
    };
  }

  const { action, value } = parsed;
  const entry = params.sessionEntry;
  const key = params.sessionKey;

  // Handle status query (no argument)
  if (action === null) {
    const currentThreshold = entry.copilotThreshold ?? 50; // Default is 50
    const status = currentThreshold === 0 ? "disabled" : `enabled (${currentThreshold})`;
    return {
      shouldContinue: false,
      reply: { text: `📊 Auto-reset: ${status}` },
    };
  }

  // Handle enable/disable/set
  let newThreshold: number;
  let replyMessage: string;

  if (action === "enable") {
    newThreshold = value!;
    replyMessage = `✅ Auto-reset enabled (default: 50)`;
  } else if (action === "disable") {
    newThreshold = 0;
    replyMessage = `✅ Auto-reset disabled`;
  } else if (action === "number") {
    newThreshold = value!;
    if (newThreshold < 0 || newThreshold > 500) {
      return {
        shouldContinue: false,
        reply: { text: "❌ Threshold must be between 0 and 500 (0 = disabled)" },
      };
    }
    replyMessage =
      newThreshold === 0 ? `✅ Auto-reset disabled` : `✅ Threshold set to ${newThreshold}`;
  } else {
    return {
      shouldContinue: false,
      reply: { text: "❌ Invalid action. Use: enable, disable, or a number" },
    };
  }

  // Apply the change
  entry.copilotThreshold = newThreshold;
  entry.updatedAt = Date.now();

  if (params.sessionStore && params.storePath) {
    params.sessionStore[key] = entry;
    await updateSessionStore(params.storePath, (store) => {
      store[key] = entry;
    });
  }

  return {
    shouldContinue: false,
    reply: { text: replyMessage },
  };
};
