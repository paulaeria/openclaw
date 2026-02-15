# OpenClaw Fork Update Procedure

**Repository:** `paulaeria/openclaw`
**Purpose:** OpenClaw with GitHub Copilot credit efficiency patches

## Branch Structure

- `main` — Tracks upstream releases (clean, no custom patches)
- `copilot-patches` — Single squashed commit with all Copilot patches on top of main
- `production` — Full commit history of patches (for debugging/reference)

## Quick Update (Quin's Workflow)

When a new OpenClaw release comes out:

```bash
cd /Users/clawd/clawd/projects/paulaeria-openclaw

# 1. Fetch upstream and tags
git fetch upstream --tags

# 2. Check the new release tag
git log --oneline v2026.X.Y -5  # Verify it's the right release

# 3. Update main to new release
git checkout main
git reset --hard v2026.X.Y
git push origin main --force

# 4. Rebase copilot-patches onto new main
git checkout copilot-patches
git rebase main

# If conflicts occur:
#   - Resolve conflicts (typically in src/agents/pi-embedded-runner/run/attempt.ts)
#   - Key: Keep BOTH Ollama native API support AND Copilot X-Initiator wrapping
#   - git add <resolved files>
#   - git rebase --continue

# 5. Push updated branches
git push origin copilot-patches --force

# 6. Test build
pnpm install
pnpm build

# 7. If successful, update the symlink and restart
cd /Users/clawd/clawd/projects
ln -sfn paulaeria-openclaw openclaw-copilot  # If needed
# Then restart gateway
```

## Conflict Resolution Guide

The most common conflict is in `src/agents/pi-embedded-runner/run/attempt.ts`:

**Pattern:** Upstream adds new stream handling (like Ollama native API), 
our patches add Copilot X-Initiator wrapping.

**Resolution:** Keep BOTH:
```typescript
if (params.model.api === "ollama") {
  // Ollama native API branch (from upstream)
  activeSession.agent.streamFn = createOllamaStreamFn(ollamaBaseUrl);
} else {
  // Copilot X-Initiator wrapping (our patch)
  const copilotAwareStream = createCopilotAwareStream(...);
  activeSession.agent.streamFn = copilotAwareStream;
}
```

## Files Modified by Copilot Patches

- `src/agents/copilot-initiator-header.ts` — Core tracker class
- `src/agents/copilot-initiator-header.*.test.ts` — Tests
- `src/agents/pi-embedded-runner/run/attempt.ts` — Integration point
- `src/agents/pi-embedded-runner/run/types.ts` — Type additions
- `src/agents/pi-embedded-runner/run/params.ts` — Param additions
- `src/config/types.models.ts` — Config type additions
- `src/config/zod-schema.core.ts` — Config schema additions
- `docs/plans/2026-02-05-copilot-x-initiator-*.md` — Design docs

## Remotes

```
origin    → git@github.com:paulaeria/openclaw.git (our fork)
upstream  → git@github.com:openclaw/openclaw.git (official)
friend    → git@openclaw-deploy:pmaeria/openclaw.git (original patches source)
```

## Current State

- **Base:** v2026.2.14
- **Patches:** 20 commits squashed into 1 on `copilot-patches`
- **Features:**
  - X-Initiator header injection for github-copilot provider
  - Session-based first-call detection (CopilotInitiatorTracker)
  - Config options: `disableInitiatorHeader`, `agentMessageResetThreshold`, `shareSessionId`
  - Global session ID sharing for subagents
  - Auto-reset threshold on model changes
