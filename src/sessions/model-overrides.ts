import type { ModelChangeReason } from "../agents/model-change-tracking.js";
import type { SessionEntry } from "../config/sessions.js";
import { copilotInitiatorTracker } from "../agents/copilot-initiator-header.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  /** Reason for model change - determines if X-Initiator tracker resets */
  reason?: ModelChangeReason;
}): { updated: boolean } {
  const { entry, selection, profileOverride, reason } = params;
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  let updated = false;

  if (selection.isDefault) {
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
    }
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
    }
  }

  if (profileOverride) {
    if (entry.authProfileOverride !== profileOverride) {
      entry.authProfileOverride = profileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource !== profileOverrideSource) {
      entry.authProfileOverrideSource = profileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  } else {
    if (entry.authProfileOverride) {
      delete entry.authProfileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource) {
      delete entry.authProfileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  }

  if (updated) {
    entry.updatedAt = Date.now();

    // Reset X-Initiator tracker on user-initiated model changes
    if (reason === "user-command") {
      copilotInitiatorTracker.onModelChanged(entry.sessionId, reason);
    }
  }

  return { updated };
}
