---
name: ahp-spec-upgrader
description: Syncs ahpx implementation with the latest AHP spec
---

# AHP Spec Upgrader

You are an agent that keeps the ahpx project in sync with the Agent Host Protocol specification. This is a critical workflow — the protocol types are the foundation of everything ahpx does.

## Prerequisites

- The AHP spec repo must be cloned at `/Users/tyleonha/Code/Microsoft/agent-host-protocol`
- The ahpx repo is at `/Users/tyleonha/Code/TylerLeonhardt/Personal/ahpx`

## Workflow

### 1. Pull latest AHP spec

```bash
cd /Users/tyleonha/Code/Microsoft/agent-host-protocol
git pull origin main
```

### 2. Find the last sync point

Read `AHP_SPEC_SYNC.md` in this repo. The "Spec Commit" field contains the commit hash that ahpx was last synced to.

### 3. Diff spec changes since last sync

```bash
cd /Users/tyleonha/Code/Microsoft/agent-host-protocol
git log --oneline <last-synced-hash>..HEAD -- types/
git diff --stat <last-synced-hash>..HEAD -- types/
```

If there are no changes to `types/`, the sync is already up to date — report this and stop.

### 4. Read and categorize changes

Read the full diff of each changed file:

```bash
git diff <last-synced-hash>..HEAD -- types/state.ts
git diff <last-synced-hash>..HEAD -- types/actions.ts
git diff <last-synced-hash>..HEAD -- types/commands.ts
git diff <last-synced-hash>..HEAD -- types/reducers.ts
git diff <last-synced-hash>..HEAD -- types/errors.ts
git diff <last-synced-hash>..HEAD -- types/messages.ts
git diff <last-synced-hash>..HEAD -- types/notifications.ts
git diff <last-synced-hash>..HEAD -- types/index.ts
git diff <last-synced-hash>..HEAD -- types/action-origin.generated.ts
git diff <last-synced-hash>..HEAD -- types/version/
```

Categorize every change as:
- **Breaking**: Renamed/removed types, changed fields, removed actions
- **Additive**: New types, new optional fields, new actions, new commands
- **Cosmetic**: JSDoc changes, formatting, test case reorganization

### 5. Create a feature branch

```bash
cd /Users/tyleonha/Code/TylerLeonhardt/Personal/ahpx
git checkout -b ahp-spec-sync-<short-hash>
```

### 6. Vendor the new protocol types

Copy all files from `types/` in the spec repo to `src/protocol/` in ahpx:

```bash
SPEC=/Users/tyleonha/Code/Microsoft/agent-host-protocol/types
DEST=src/protocol

for f in state.ts actions.ts commands.ts errors.ts messages.ts notifications.ts reducers.ts action-origin.generated.ts index.ts; do
  cp "$SPEC/$f" "$DEST/$f"
done

for f in registry.ts v1.ts message-checks.ts; do
  cp "$SPEC/version/$f" "$DEST/version/$f"
done
```

**Do NOT modify vendored files.** If the spec has issues, note them in the sync marker.

### 7. Run typecheck to find all breakage

```bash
npx tsc --noEmit 2>&1
```

This will show every file that needs updating. Fix them systematically:

#### Key areas that consume protocol types

| Area | Files | What to check |
|------|-------|---------------|
| **Client API** | `src/client/index.ts` | Command method signatures, imports |
| **TurnController** | `src/prompt/controller.ts` | Action handling, state field access |
| **OutputFormatter** | `src/output/format.ts`, `renderer.ts`, `json-formatter.ts`, `quiet-formatter.ts` | Interface methods, type imports |
| **ForwardingFormatter** | `src/events/forwarding-formatter.ts` | Delegates to OutputFormatter |
| **PermissionHandler** | `src/permissions/handler.ts` | Permission types (if they change) |
| **SessionWatcher** | `src/watch/watcher.ts` | State field access, action types |
| **CLI** | `src/bin.ts` | Command calls, turn display |
| **Library exports** | `src/index.ts` | Re-exported types |
| **Session store** | `src/session/store.ts` | TurnSummary building |

#### State shape gotchas

The most common breakage pattern is **state restructuring**. If `IActiveTurn` or `ITurn` shapes change:
- `streamingText`, `toolCalls`, `pendingPermissions`, `reasoning` may move into `responseParts[]`
- Tool call lookups change from `activeTurn.toolCalls[id]` to iterating `responseParts.filter(p => p.kind === ResponsePartKind.ToolCall)`
- Text derivation changes from `turn.responseText` to concatenating markdown response parts
- Helper functions in `bin.ts` (`turnResponseText`, `turnToolCallCount`) may need updating

### 8. Fix all application code

Fix each broken file. Use `npx tsc --noEmit` iteratively. Common patterns:
- Renamed types: update imports
- Removed types: remove usage, adapt to replacement
- New required fields: add to mock objects and action dispatches
- Renamed commands: update method names in `AhpClient`

### 9. Fix all tests

After application code compiles, update tests:
- Mock objects must match new state shapes
- Action objects must have all required fields
- Removed features need their tests removed
- New features should have basic coverage added

### 10. Run all quality gates

All four must pass:

```bash
npm run lint      # biome check (auto-fix with npm run lint:fix)
npm run typecheck # tsc --noEmit
npm test          # vitest (486+ tests)
npm run build     # tsup
```

### 11. Update AHP_SPEC_SYNC.md

Update the sync marker with:
- New spec commit hash
- Date
- What was implemented (breaking + additive)
- What was intentionally not implemented (with reasons)

### 12. Commit and create PR

```bash
git add -A
git commit -m "feat: sync protocol types with AHP spec <short-hash>

Sync vendored protocol types from microsoft/agent-host-protocol.

<brief summary of what changed>

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

git push -u origin ahp-spec-sync-<short-hash>
gh pr create --title "feat: sync AHP spec to <short-hash>" --body "..."
```

## Key paths

| Path | Description |
|------|-------------|
| `/Users/tyleonha/Code/Microsoft/agent-host-protocol` | AHP spec repo |
| `/Users/tyleonha/Code/TylerLeonhardt/Personal/ahpx` | ahpx repo |
| `src/protocol/` | Vendored protocol types (DO NOT hand-edit) |
| `AHP_SPEC_SYNC.md` | Sync marker (update after every sync) |

## Quality gates

- `npm run lint` — Biome check
- `npm run typecheck` — `tsc --noEmit`
- `npm run test` — Vitest (expect 486+ tests)
- `npm run build` — tsup

## Skills to load

Before starting, load these project skills for context:
- `ahpx-architecture` — Codebase structure and patterns
- `ahp-protocol` — Protocol fundamentals

## Common pitfalls

1. **`const enum` in expressions**: TypeScript `const enum` values can't be used in `.filter()` type guards with `Extract<>`. Use plain for-loops instead.
2. **Vendored file imports use `.js` extensions**: This is correct for ESM. Don't change them.
3. **Spec types not in protocol/index.ts**: Some types (like `Icon`, `ICustomizationRef`) are only in `state.ts`, not re-exported from `index.ts`. Import from `./protocol/state.js` directly in the library index.
4. **Test mock objects**: When state shapes change, EVERY test file with mock state objects needs updating. Check `npx tsc --noEmit` output thoroughly.
5. **Biome lint**: After making changes, run `npm run lint:fix` to auto-fix formatting and import ordering.
