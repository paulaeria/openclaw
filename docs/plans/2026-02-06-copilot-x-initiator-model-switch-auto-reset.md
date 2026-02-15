# GitHub Copilot X-Initiator Header: Model Switch & Auto-Reset Enhancement

**Created:** 2026-02-06  
**Status:** Planning  
**Related:** `2026-02-05-copilot-x-initiator-header-implementation.md` (original implementation)

---

## Problem Statement

The current `X-Initiator` header implementation resets only when users explicitly trigger `/new` or `/reset`. However, there are two additional scenarios where we should reset to `X-Initiator: user`:

1. **User-initiated model changes** (via `/model` command, UI picker, or inline model selection)
2. **Auto-reset after N agent messages** to avoid GitHub Copilot flagging long-running agent sequences

### Why This Matters

**Model switching:**  
When a user explicitly changes models mid-conversation, they're signaling a new conversation context. The next message should count as a fresh user request, not a continuation of the previous agent chain.

**Auto-reset rationale:**  
Copilot's API may flag sessions where hundreds of consecutive calls use `X-Initiator: agent`. By periodically resetting to `user` after N agent messages, we:

- Maintain a more natural request pattern
- Reduce risk of quota throttling or API restrictions
- Still save significant quota compared to marking every call as `user`

---

## Current Implementation Analysis

### Where X-Initiator Currently Resets

**File:** `src/auto-reply/reply/session.ts`

```typescript
// Reset triggers: /new, /reset (configurable via session.resetTriggers)
for (const trigger of resetTriggers) {
  if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
    isNewSession = true;
    resetTriggered = true;
    break;
  }
}

const previousSessionEntry = resetTriggered && entry ? { ...entry } : undefined;
```

**Result:** When `resetTriggered = true`, the session resets, which eventually calls `copilotInitiatorTracker.reset(sessionId)`.

### Where Model Changes Happen

**Key locations:**

1. **`src/sessions/model-overrides.ts`**
   - `applyModelOverrideToSessionEntry()` - applies model/provider overrides to session entry
   - Called from multiple places (command handlers, directive handling, gateway API)

2. **`src/commands/model-picker.ts`**
   - `promptDefaultModel()` - interactive model selection (CLI/UI)
   - `applyPrimaryModel()` - applies model to config

3. **`src/auto-reply/reply/model-selection.ts`**
   - Handles inline model selection during conversation

4. **`src/agents/tools/session-status-tool.ts`**
   - Model override via `/status` command

5. **`src/gateway/sessions-patch.ts`**
   - API endpoint for model changes via web UI

### Where Initiator Tracker is Used

**File:** `src/agents/pi-embedded-runner/run/attempt.ts`

```typescript
import {
  copilotInitiatorTracker,
  createCopilotAwareStream,
} from "../../copilot-initiator-header.js";

// Wraps streamSimple with X-Initiator injection
const copilotAwareStream = createCopilotAwareStream(
  params.provider,
  params.sessionId,
  copilotInitiatorTracker,
  originalStreamSimple,
  params.config?.providers?.githubCopilot,
);
```

---

## Proposed Solution

### Enhancement 1: Reset on User-Initiated Model Change

**Design Decision:**  
Only reset on **explicit user actions**, NOT on:

- Auto-failover (system retries with different model)
- Default model from config
- Session-level overrides applied automatically

**Implementation Strategy:**  
Add a `ModelChangeReason` type and centralized hook for tracking model changes.

#### Step 1: Define Model Change Reasons

```typescript
// src/agents/model-change-tracking.ts (NEW FILE)

export type ModelChangeReason =
  | "user-command" // /model command, UI picker, inline selection
  | "failover" // Auto-retry with different model
  | "config-default" // Default model from config
  | "session-override" // Per-session override applied automatically
  | "unknown"; // Fallback

export type ModelChangeEvent = {
  sessionId: string;
  reason: ModelChangeReason;
  provider: string;
  model: string;
  previousProvider?: string;
  previousModel?: string;
};
```

#### Step 2: Add Hook to Copilot Tracker

```typescript
// src/agents/copilot-initiator-header.ts (MODIFY)

import type { ModelChangeReason } from "./model-change-tracking.js";

export class CopilotInitiatorTracker {
  // ... existing code ...

  onModelChanged(sessionId: string, reason: ModelChangeReason): void {
    if (reason === "user-command") {
      this.reset(sessionId);
      log.debug(`copilot x-initiator: reset on model change (sessionId=${sessionId})`);
    }
  }
}
```

#### Step 3: Wire Up Model Change Calls

**3a. In `applyModelOverrideToSessionEntry`** (most common path):

```typescript
// src/sessions/model-overrides.ts (MODIFY)

import { copilotInitiatorTracker } from "../agents/copilot-initiator-header.js";
import type { ModelChangeReason } from "../agents/model-change-tracking.js";

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  reason?: ModelChangeReason; // NEW PARAMETER
}): { updated: boolean } {
  const { entry, selection, profileOverride, reason } = params;
  // ... existing logic ...

  if (updated && reason === "user-command") {
    copilotInitiatorTracker.onModelChanged(entry.sessionId, reason);
  }

  return { updated };
}
```

**3b. Update all callers of `applyModelOverrideToSessionEntry`:**

| File                                                 | Location               | Change                                                       |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `src/agents/tools/session-status-tool.ts`            | `/status` model change | Add `reason: "user-command"`                                 |
| `src/commands/agent.ts`                              | CLI agent command      | Add `reason: "user-command"`                                 |
| `src/auto-reply/reply/model-selection.ts`            | Inline model selection | Add `reason: "user-command"`                                 |
| `src/auto-reply/reply/directive-handling.impl.ts`    | Directive handling     | Add `reason: "user-command"` or `"unknown"` based on context |
| `src/auto-reply/reply/directive-handling.persist.ts` | Persisted directives   | Add `reason: "unknown"` (defer to safe default)              |
| `src/auto-reply/reply/session-reset-model.ts`        | Reset model on `/new`  | Add `reason: "config-default"` (no reset needed)             |
| `src/gateway/sessions-patch.ts`                      | Web UI model change    | Add `reason: "user-command"`                                 |

**3c. Model failover tracking:**

In `src/agents/model-fallback.ts` (or wherever failover happens):

```typescript
import type { ModelChangeReason } from "./model-change-tracking.js";

// When failing over:
const reason: ModelChangeReason = "failover";
// Do NOT reset copilot tracker
```

---

### Enhancement 2: Auto-Reset After N Agent Messages

**Goal:** Reset to `X-Initiator: user` every N consecutive agent calls to maintain a natural pattern.

**Configuration:**

```typescript
// src/config/zod-schema.providers.ts (MODIFY)

githubCopilot: z.object({
  // ... existing fields ...
  disableInitiatorHeader: z.boolean().optional().default(false),
  agentMessageResetThreshold: z.number().int().min(1).optional().default(50), // NEW
});
```

**Default:** 50 agent messages before reset (configurable)

**Implementation:**

```typescript
// src/agents/copilot-initiator-header.ts (MODIFY)

export class CopilotInitiatorTracker {
  #firstCallMade = new Set<string>();
  #sessionTimestamps = new Map<string, number>();
  #agentMessageCount = new Map<string, number>(); // NEW

  getInitiator(sessionId: string, resetThreshold?: number): "user" | "agent" {
    const threshold = resetThreshold ?? 50; // Default threshold

    if (this.#firstCallMade.has(sessionId)) {
      // Increment agent message count
      const count = (this.#agentMessageCount.get(sessionId) ?? 0) + 1;
      this.#agentMessageCount.set(sessionId, count);

      // Auto-reset if threshold reached
      if (count >= threshold) {
        log.debug(
          `copilot x-initiator: auto-reset after ${count} agent messages (sessionId=${sessionId})`,
        );
        this.#agentMessageCount.set(sessionId, 0);
        return "user";
      }

      return "agent";
    }

    // First call - reset counter
    this.#firstCallMade.add(sessionId);
    this.#sessionTimestamps.set(sessionId, Date.now());
    this.#agentMessageCount.set(sessionId, 0);
    return "user";
  }

  reset(sessionId: string): void {
    this.#firstCallMade.delete(sessionId);
    this.#sessionTimestamps.delete(sessionId);
    this.#agentMessageCount.delete(sessionId); // NEW
  }

  cleanup(): void {
    const now = Date.now();
    for (const [sessionId, timestamp] of this.#sessionTimestamps) {
      if (now - timestamp > CLEANUP_INTERVAL_MS) {
        this.#firstCallMade.delete(sessionId);
        this.#sessionTimestamps.delete(sessionId);
        this.#agentMessageCount.delete(sessionId); // NEW
      }
    }
  }
}
```

**Wire up threshold config:**

```typescript
// src/agents/pi-embedded-runner/run/attempt.ts (MODIFY)

const copilotAwareStream = createCopilotAwareStream(
  params.provider,
  params.sessionId,
  copilotInitiatorTracker,
  originalStreamSimple,
  params.config?.providers?.githubCopilot, // Already passed
);
```

Update `createCopilotAwareStream` signature:

```typescript
// src/agents/copilot-initiator-header.ts (MODIFY)

export function createCopilotAwareStream(
  provider: string,
  sessionId: string,
  tracker: CopilotInitiatorTracker,
  originalStreamSimple: StreamFn,
  config?: {
    disableInitiatorHeader?: boolean;
    agentMessageResetThreshold?: number; // NEW
  },
): StreamFn {
  return async function streamWithInitiatorHeader(model, context, options) {
    const headers = { ...options?.headers };

    if (provider === "github-copilot" && !config?.disableInitiatorHeader) {
      const threshold = config?.agentMessageResetThreshold;
      const initiator = tracker.getInitiator(sessionId, threshold);
      headers["X-Initiator"] = initiator;
      log.debug(`copilot x-initiator: sessionId=${sessionId} initiator=${initiator}`);
    }

    return originalStreamSimple(model, context, { ...options, headers });
  };
}
```

---

## File Change Summary

### New Files

| File                                                       | Purpose                                   | LOC  |
| ---------------------------------------------------------- | ----------------------------------------- | ---- |
| `src/agents/model-change-tracking.ts`                      | Type definitions for model change reasons | ~30  |
| `src/agents/copilot-initiator-header.test.model-change.ts` | Tests for model change reset behavior     | ~150 |
| `src/agents/copilot-initiator-header.test.auto-reset.ts`   | Tests for auto-reset threshold behavior   | ~100 |

### Modified Files

| File                                                 | Changes                                       | Lines Changed |
| ---------------------------------------------------- | --------------------------------------------- | ------------- |
| `src/agents/copilot-initiator-header.ts`             | Add `onModelChanged()`, auto-reset logic      | ~30           |
| `src/config/zod-schema.providers.ts`                 | Add `agentMessageResetThreshold` config field | ~2            |
| `src/sessions/model-overrides.ts`                    | Add `reason` parameter, call tracker hook     | ~10           |
| `src/agents/tools/session-status-tool.ts`            | Pass `reason: "user-command"`                 | ~2            |
| `src/commands/agent.ts`                              | Pass `reason: "user-command"`                 | ~2            |
| `src/auto-reply/reply/model-selection.ts`            | Pass `reason: "user-command"`                 | ~2            |
| `src/auto-reply/reply/directive-handling.impl.ts`    | Pass appropriate reason                       | ~2            |
| `src/auto-reply/reply/directive-handling.persist.ts` | Pass appropriate reason                       | ~2            |
| `src/auto-reply/reply/session-reset-model.ts`        | Pass `reason: "config-default"`               | ~2            |
| `src/gateway/sessions-patch.ts`                      | Pass `reason: "user-command"`                 | ~2            |

**Total:** ~340 LOC (including tests)

---

## Implementation Steps

### Phase 1: Model Change Reset

**Task 1.1:** Create type definitions

- Create `src/agents/model-change-tracking.ts`
- Define `ModelChangeReason` type
- Export `ModelChangeEvent` type

**Task 1.2:** Add tracker hook

- Modify `CopilotInitiatorTracker` class
- Add `onModelChanged()` method
- Add debug logging

**Task 1.3:** Update model override function

- Modify `applyModelOverrideToSessionEntry()`
- Add `reason` parameter
- Call tracker hook when `reason === "user-command"`

**Task 1.4:** Wire up all callers (TDD approach)

- Write failing tests for each caller
- Update callers to pass `reason`
- Run tests to verify

**Task 1.5:** Add integration tests

- Test model change resets X-Initiator
- Test failover does NOT reset
- Test config defaults do NOT reset

---

### Phase 2: Auto-Reset Threshold

**Task 2.1:** Add config schema

- Update `src/config/zod-schema.providers.ts`
- Add `agentMessageResetThreshold` field
- Set default to 50

**Task 2.2:** Add counter tracking

- Modify `CopilotInitiatorTracker.getInitiator()`
- Add `#agentMessageCount` map
- Implement threshold logic
- Update `reset()` and `cleanup()` to handle counter

**Task 2.3:** Wire up config

- Update `createCopilotAwareStream()` signature
- Pass threshold to `getInitiator()`

**Task 2.4:** Add tests

- Test auto-reset at threshold
- Test threshold = 1 (every message)
- Test threshold = 0 or disabled
- Test counter persists across normal calls
- Test counter resets on explicit reset

---

### Phase 3: Documentation & Validation

**Task 3.1:** Update documentation

- Modify `docs/providers/github-copilot.md`
- Add section on model change reset behavior
- Add section on auto-reset threshold
- Document config options

**Task 3.2:** Add CHANGELOG entry

```markdown
## Enhancements

- **GitHub Copilot X-Initiator:** Now resets to `user` on explicit model changes (e.g., `/model opus`), treating model switches as new conversation contexts.
- **GitHub Copilot X-Initiator:** Added auto-reset after N consecutive agent messages (default: 50) to maintain natural request patterns and reduce risk of API throttling. Configurable via `providers.githubCopilot.agentMessageResetThreshold`.
```

**Task 3.3:** Run full test suite

```bash
pnpm test
pnpm build
pnpm check
```

**Task 3.4:** Manual validation (optional)

- Test with real Copilot API
- Verify quota usage patterns
- Check logs for reset behavior

---

## Edge Cases & Considerations

### Edge Case 1: Model change during streaming response

**Scenario:**

```
User: "Help me code"
Agent: <streaming response...>
User: /model opus [mid-stream]
```

**Solution:**  
Reset happens on the session entry update. The next API call will use `X-Initiator: user`.

**Risk:** Low. Model changes during streaming are rare and session state is updated atomically.

---

### Edge Case 2: Rapid model changes

**Scenario:**

```
User: /model sonnet
User: /model opus
User: /model haiku [rapid-fire]
User: "Now help me"
```

**Solution:**  
Each model change calls `reset()`, which is idempotent. The next message will be `user` regardless.

**Risk:** None. Multiple resets are safe.

---

### Edge Case 3: Threshold reached but user sends message

**Scenario:**

```
Agent: <49 agent calls>
Agent: <50th call - auto-reset to "user">
User: "Do another thing" [real user message]
```

**Result:** User message would be the 51st call, still marked as `agent`.

**Solution:** This is acceptable. The auto-reset is a periodic "refresh" to avoid long agent chains. The user's next message doesn't need special handling because the 50th call already reset the pattern.

**Alternative:** Track "last message was from real user" separately and always use `user` for those. **Recommendation: NOT NEEDED** — the current approach is simpler and achieves the goal.

---

### Edge Case 4: User sets threshold = 1 (every message is "user")

**Scenario:**

```yaml
providers:
  github-copilot:
    agentMessageResetThreshold: 1
```

**Result:** Every call uses `X-Initiator: user` (no optimization).

**Solution:** This is intentional. User can effectively disable the optimization by setting threshold to 1.

**Risk:** None. It's a valid config choice.

---

### Edge Case 5: Failover happens mid-conversation

**Scenario:**

```
User: "Complex task" [X-Initiator: user]
Agent: <Sonnet tries, fails>
Agent: <Auto-failover to Opus> [X-Initiator: ???]
```

**Solution:** Pass `reason: "failover"` when applying model override during failover. This will NOT reset the tracker, so subsequent calls remain `agent`.

**Risk:** Need to verify failover code path passes correct reason.

---

## Testing Strategy

### Unit Tests

```typescript
// src/agents/copilot-initiator-header.test.model-change.ts

describe("CopilotInitiatorTracker - model changes", () => {
  it("should reset on user-command", () => {
    const tracker = new CopilotInitiatorTracker();
    expect(tracker.getInitiator("s1")).toBe("user");
    expect(tracker.getInitiator("s1")).toBe("agent");

    tracker.onModelChanged("s1", "user-command");

    expect(tracker.getInitiator("s1")).toBe("user");
  });

  it("should NOT reset on failover", () => {
    const tracker = new CopilotInitiatorTracker();
    expect(tracker.getInitiator("s1")).toBe("user");
    expect(tracker.getInitiator("s1")).toBe("agent");

    tracker.onModelChanged("s1", "failover");

    expect(tracker.getInitiator("s1")).toBe("agent");
  });

  it("should NOT reset on config-default", () => {
    const tracker = new CopilotInitiatorTracker();
    expect(tracker.getInitiator("s1")).toBe("user");
    expect(tracker.getInitiator("s1")).toBe("agent");

    tracker.onModelChanged("s1", "config-default");

    expect(tracker.getInitiator("s1")).toBe("agent");
  });
});
```

```typescript
// src/agents/copilot-initiator-header.test.auto-reset.ts

describe("CopilotInitiatorTracker - auto-reset threshold", () => {
  it("should reset after N agent messages", () => {
    const tracker = new CopilotInitiatorTracker();
    const threshold = 3;

    expect(tracker.getInitiator("s1", threshold)).toBe("user");
    expect(tracker.getInitiator("s1", threshold)).toBe("agent");
    expect(tracker.getInitiator("s1", threshold)).toBe("agent");
    expect(tracker.getInitiator("s1", threshold)).toBe("user"); // Reset at threshold
    expect(tracker.getInitiator("s1", threshold)).toBe("agent");
  });

  it("should use default threshold if not provided", () => {
    const tracker = new CopilotInitiatorTracker();

    expect(tracker.getInitiator("s1")).toBe("user");
    for (let i = 0; i < 49; i++) {
      expect(tracker.getInitiator("s1")).toBe("agent");
    }
    expect(tracker.getInitiator("s1")).toBe("user"); // Reset at 50
  });

  it("should handle threshold = 1 (every message is user)", () => {
    const tracker = new CopilotInitiatorTracker();

    expect(tracker.getInitiator("s1", 1)).toBe("user");
    expect(tracker.getInitiator("s1", 1)).toBe("user");
    expect(tracker.getInitiator("s1", 1)).toBe("user");
  });

  it("should reset counter on explicit reset", () => {
    const tracker = new CopilotInitiatorTracker();
    const threshold = 3;

    expect(tracker.getInitiator("s1", threshold)).toBe("user");
    expect(tracker.getInitiator("s1", threshold)).toBe("agent");

    tracker.reset("s1");

    expect(tracker.getInitiator("s1", threshold)).toBe("user");
    expect(tracker.getInitiator("s1", threshold)).toBe("agent");
  });
});
```

### Integration Tests

```typescript
// src/sessions/model-overrides.test.copilot.ts

describe("applyModelOverrideToSessionEntry - Copilot integration", () => {
  it("should reset Copilot tracker on user-command", () => {
    const entry = { sessionId: "test-session", updatedAt: Date.now() };
    const selection = { provider: "github-copilot", model: "claude-sonnet-4" };

    // Simulate first call (user)
    copilotInitiatorTracker.getInitiator(entry.sessionId);
    // Simulate agent call
    expect(copilotInitiatorTracker.getInitiator(entry.sessionId)).toBe("agent");

    // Apply model override with user-command reason
    applyModelOverrideToSessionEntry({
      entry,
      selection,
      reason: "user-command",
    });

    // Next call should be user
    expect(copilotInitiatorTracker.getInitiator(entry.sessionId)).toBe("user");
  });
});
```

---

## Configuration Examples

### Default behavior (recommended)

```yaml
providers:
  github-copilot:
    # X-Initiator optimization enabled by default
    # Resets on /new, model changes, and every 50 agent messages
```

### Conservative (reset more frequently)

```yaml
providers:
  github-copilot:
    agentMessageResetThreshold: 20 # Reset every 20 agent calls
```

### Aggressive (minimize resets)

```yaml
providers:
  github-copilot:
    agentMessageResetThreshold: 200 # Only reset every 200 agent calls
```

### Disable optimization entirely

```yaml
providers:
  github-copilot:
    disableInitiatorHeader: true # All calls use X-Initiator: user
```

---

## Success Criteria

- [ ] Model changes via `/model` command reset X-Initiator
- [ ] Model changes via UI picker reset X-Initiator
- [ ] Model changes via inline selection reset X-Initiator
- [ ] Failover does NOT reset X-Initiator
- [ ] Auto-reset triggers at configured threshold
- [ ] Explicit `/new` still resets X-Initiator
- [ ] All existing tests pass
- [ ] New tests achieve >90% coverage
- [ ] Documentation updated
- [ ] CHANGELOG entry added

---

## References

- Original implementation: `docs/plans/2026-02-05-copilot-x-initiator-header-implementation.md`
- OpenClaw CLAUDE.md: Commit guidelines, testing requirements
- Session management: `src/auto-reply/reply/session.ts`
- Model overrides: `src/sessions/model-overrides.ts`
- Config schema: `src/config/zod-schema.providers.ts`

---

## Notes

- **Why 50 as default threshold?** Balances quota savings with natural request patterns. Long enough to capture multi-tool workflows, short enough to avoid appearing as a single endless session.
- **Why not reset on every user message?** The tracker already marks the _first_ message in a session as `user`. Subsequent user messages within the same conversation are part of the agent's response flow (tool results → agent → user → agent).
- **Backward compatibility:** All changes are backward compatible. Existing behavior is preserved when `reason` parameter is omitted (defaults to safe behavior).
