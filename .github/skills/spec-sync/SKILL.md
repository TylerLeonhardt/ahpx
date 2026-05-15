---
description: >-
  AHP spec sync process — how to update ahpx protocol types from the
  microsoft/agent-host-protocol spec repo. Use when syncing protocol types,
  diagnosing type mismatches, or understanding the vendored types workflow.
---

# AHP Spec Sync

ahpx **vendors** protocol type definitions from the
[microsoft/agent-host-protocol](https://github.com/microsoft/agent-host-protocol)
spec repo. The types are copied 1:1 from the spec's `types/` directory into
ahpx's `src/protocol/` directory — no transformation, no code generation.

## File mapping

```
spec repo: types/          →  ahpx: src/protocol/
```

Every file in `types/` is copied verbatim into `src/protocol/`. There is no
build step, no transformation layer, and no cherry-picking. The entire directory
is replaced wholesale.

## Sync marker

`AHP_SPEC_SYNC.md` at the ahpx repo root tracks the last synced commit hash.
It contains a table with:

| Field | Purpose |
|-------|---------|
| **Spec Commit** | The spec repo commit hash that was last synced |
| **Spec Repo** | `microsoft/agent-host-protocol` |
| **Synced On** | Date of the sync |
| **ahpx Commit** | The ahpx branch/PR where the sync landed |

Always read this file first to know the current sync point.

## Step-by-step sync process

### 1. Pull latest from spec repo

Locate your local clone of
[microsoft/agent-host-protocol](https://github.com/microsoft/agent-host-protocol)
(clone it first if you don't have one), then pull the latest:

```bash
cd <spec-repo-path>   # local clone of microsoft/agent-host-protocol
git checkout main && git pull
```

### 2. Read the current sync point

Open `AHP_SPEC_SYNC.md` in the ahpx repo and note the **Spec Commit** hash.

### 3. Diff the spec changes

```bash
cd <spec-repo-path>   # local clone of microsoft/agent-host-protocol
git diff <old-hash>..HEAD -- types/
```

Review the diff to understand what changed — new types, renamed fields, removed
enums, changed shapes. This informs what will break downstream.

### 4. Copy types into ahpx

Copy all files from the spec's `types/` directory into ahpx's `src/protocol/`,
replacing existing files entirely.

### 5. Typecheck to find breakage

From the ahpx project root:

```bash
npx tsc --noEmit
```

This will surface every compile error caused by the new types.

### 6. Fix application code and tests

Work through each type error. The consumer areas listed below are the most
common places that break.

### 7. Run all quality gates

All four must pass before the sync is complete:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run build       # esbuild bundle
```

### 8. Update the sync marker

Edit `AHP_SPEC_SYNC.md` with:
- New spec commit hash
- Current date
- Summary of breaking changes applied, additive features added, and anything
  intentionally deferred

### 9. Commit, push, and open a PR

Create a branch (e.g., `ahp-spec-sync-<short-hash>`), commit all changes, push,
and open a PR with a clear changelog.

## Consumer areas that typically break

When spec types change shape, these areas of the ahpx codebase are most likely
to need updates:

| Directory / File | Why it breaks |
|------------------|---------------|
| `src/client/` | Directly consumes protocol types for commands, actions, state |
| `src/prompt/` | Builds protocol-typed request payloads |
| `src/output/` | Renders protocol-typed response data |
| `src/events/` | Forwards protocol-typed actions as events |
| `src/permissions/` | Maps protocol permission types to CLI prompts |
| `src/watch/` | Observes state changes using protocol shapes |
| `src/session/` | Session lifecycle uses protocol session types |
| `src/bin.ts` | CLI entry point wires everything together |

## Common pitfalls

### Const enums in expressions

TypeScript `const enum` values are inlined at compile time and cannot be used as
runtime values (e.g., in `Object.values()`, re-exports, or switch default
checks). If the spec introduces a new const enum, ensure application code uses
it only in type positions or direct comparisons.

### .js extensions for ESM imports

ahpx uses ESM with `.js` extensions in import paths. When adding new files to
`src/protocol/`, ensure all cross-file imports within the protocol directory use
`.js` extensions:

```typescript
// ✅ correct
import { SessionStatus } from './enums.js';

// ❌ wrong — will fail at runtime under ESM
import { SessionStatus } from './enums';
```

### State shape changes cascading through reducers

Protocol types define the state shape. When a state interface changes (e.g., a
field is added, renamed, or removed), the change cascades through:

1. **Reducers** — must produce the new shape
2. **StateMirror** — must track/expose the new fields
3. **Tests** — fixture data and assertions must match the new shape

Trace the type through the full reducer → mirror → consumer chain before
considering the fix complete.

## Quality gates

Every spec sync must pass all four gates before merging:

| Gate | Command | What it catches |
|------|---------|-----------------|
| **Typecheck** | `npm run typecheck` | Type mismatches from changed protocol shapes |
| **Lint** | `npm run lint` | Style violations, unused imports from removed types |
| **Test** | `npm test` | Behavioral regressions in reducers, client, output |
| **Build** | `npm run build` | Bundle errors, missing exports, runtime import issues |
