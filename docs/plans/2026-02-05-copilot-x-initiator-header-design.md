# GitHub Copilot X-Initiator Header Implementation

## Overview

This document describes the design for implementing the `X-Initiator` header optimization for GitHub Copilot API calls in OpenClaw. This optimization reduces premium quota consumption by distinguishing between user-initiated requests (counted against quota) and agent/tool-initiated requests (exempt from quota).

## Problem Statement

GitHub Copilot enforces a premium request quota (50 requests/month on free plans, higher on paid plans). Currently, all API calls—including those initiated by tools, subagents, or assistant follow-ups—count against this quota. This leads to rapid quota exhaustion in tool-heavy workflows.

The `X-Initiator: agent` header is an undocumented but widely-used mechanism to exempt non-user-initiated calls from premium quota counting.

## Goals

1. Reduce premium quota usage for GitHub Copilot users
2. Apply optimization only to Copilot provider (no impact on other providers)
3. Implement within OpenClaw (without modifying external SDK)
4. Use session-based detection: first message = user, subsequent = agent

## Architecture

### High-Level Flow

```
User message → OpenClaw agent runner → X-Initiator wrapper → pi-ai SDK → GitHub Copilot API
                                                              ↓
                                                      Inject X-Initiator header
```

### Components

#### 1. `CopilotInitiatorTracker` Class

Tracks whether a session has made its first API call.

```typescript
class CopilotInitiatorTracker {
  private firstCallMade = new Set<string>();

  getInitiator(sessionId: string): "user" | "agent" {
    if (this.firstCallMade.has(sessionId)) {
      return "agent";
    }
    this.firstCallMade.add(sessionId);
    return "user";
  }

  reset(sessionId: string): void {
    this.firstCallMade.delete(sessionId);
  }
}
```

#### 2. `createCopilotAwareStream` Wrapper Function

Wraps `@mariozechner/pi-ai`'s `streamSimple()` to inject the header.

```typescript
function createCopilotAwareStream(
  provider: string,
  sessionId: string,
  tracker: CopilotInitiatorTracker,
  originalStreamSimple: StreamFn
): StreamFn {
  return async function streamWithInitiatorHeader(...) {
    const headers = {};

    if (provider === "github-copilot") {
      const initiator = tracker.getInitiator(sessionId);
      headers["X-Initiator"] = initiator;
    }

    return originalStreamSimple(..., { headers });
  };
}
```

#### 3. Integration Point

Modified `src/agents/pi-embedded-runner/run/attempt.ts`:

```typescript
import { copilotInitiatorTracker, createCopilotAwareStream } from "../copilot-initiator-header.js";

// Inside runEmbeddedAttempt():
const originalStreamSimple = streamSimple;
const stream = createCopilotAwareStream(
  params.provider,
  params.sessionId,
  copilotInitiatorTracker,
  originalStreamSimple
);
```

## File Structure

```
src/agents/
├── copilot-initiator-header.ts      (NEW - ~150 LOC)
├── copilot-initiator-header.test.ts (NEW - ~200 LOC)
└── pi-embedded-runner/
    └── run/
        └── attempt.ts               (MODIFY - ~5 lines changed)
```

## Configuration

Optional config flag for users who want to disable the optimization:

```typescript
// src/config/zod-schema.providers.ts
githubCopilot: z.object({
  disableInitiatorHeader: z.boolean().optional().default(false),
})
```

## Error Handling & Edge Cases

| Scenario | Behavior |
|----------|----------|
| Provider detection fails | Default to `X-Initiator: user` (safer to count as premium) |
| Session ID missing | Generate temporary ID: `"temp-${Date.now()}"` |
| Tracker state grows too large | Auto-cleanup: remove sessions older than 24 hours |
| Multiple concurrent agents | Thread-safe (Node.js single-threaded, Set-based) |
| Session retry/retry | Retry does NOT count as new first call (only true user prompts) |
| Non-Copilot providers | Pass through unchanged, zero overhead |

## Session Lifecycle

1. **New session starts** → `firstCallMade` Set doesn't contain `sessionId`
2. **First API call** → Returns `X-Initiator: user`, marks session as initialized
3. **Tool execution** → `X-Initiator: agent`
4. **Agent follow-up** → `X-Initiator: agent`
5. **Session ends** → State persists (explicit `reset()` for new conversations)

## Testing Strategy

1. **Unit tests**: `CopilotInitiatorTracker` class behavior
2. **Integration tests**: Wrapper function with mocked SDK
3. **Regression tests**: Ensure existing Copilot tests still pass
4. **Live test**: Verify with real Copilot API that usage doesn't increase unexpectedly

## Logging

Debug logs for verification:

```typescript
log.debug(`copilot x-initiator: sessionId=${sessionId} initiator=${initiator}`);
```

## Backward Compatibility

- No breaking changes to existing API
- Users without Copilot see zero impact
- Feature is transparent unless examining network logs

## References

- [anomalyco/opencode PR #595](https://github.com/anomalyco/opencode/pull/595) - Original implementation
- [Understanding Copilot requests](https://docs.github.com/en/copilot/managing-copilot/configuring-personal-settings-for-github-copilot/understanding-copilot-requests) - GitHub's official billing concepts
- Similar implementations: codecompanion.nvim, BerriAI/litellm, RooCodeInc/Roo-Code
