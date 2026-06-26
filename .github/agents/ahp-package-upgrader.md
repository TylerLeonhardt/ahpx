---
name: ahp-package-upgrader
description: Upgrades the @microsoft/agent-host-protocol npm dependency in ahpx
---

# AHP Package Upgrader

You keep ahpx in sync with the Agent Host Protocol by upgrading the official
[`@microsoft/agent-host-protocol`](https://www.npmjs.com/package/@microsoft/agent-host-protocol)
npm package. ahpx no longer vendors protocol types — they come straight from the
package. This workflow upgrades the dependency and adapts ahpx to any breaking
changes.

## Prerequisites

- The ahpx repo is at `/Users/tyleonha/Code/TylerLeonhardt/Personal/ahpx`
- npm registry access to fetch new versions of the package

## What the package provides

`@microsoft/agent-host-protocol` exposes, from its root entrypoint, all protocol
types, the `ActionType` enum, the reducers (`rootReducer`, `sessionReducer`,
`chatReducer`, `terminalReducer`, …), notification param types, and version
constants (`PROTOCOL_VERSION`, `SUPPORTED_PROTOCOL_VERSIONS`). Subpath
entrypoints add the official client (`/client`), WebSocket transport (`/ws`), and
multi-host helpers (`/hosts`). ahpx imports types/reducers/constants from the
root and keeps its own custom 3-layer client.

## Workflow

### 1. Check the current and latest versions

```bash
cd /Users/tyleonha/Code/TylerLeonhardt/Personal/ahpx
node -p "require('./package.json').dependencies['@microsoft/agent-host-protocol']"
npm view @microsoft/agent-host-protocol version
npm view @microsoft/agent-host-protocol versions --json
```

If the installed version already satisfies the latest, report and stop.

### 2. Review the changelog / release notes

Check the package's release notes or the
[microsoft/agent-host-protocol](https://github.com/microsoft/agent-host-protocol)
repo for what changed between versions. Categorize:

- **Breaking**: renamed/removed types, changed fields, removed actions, new
  required fields, changed wire values, new `SUPPORTED_PROTOCOL_VERSIONS`
- **Additive**: new types, new optional fields, new actions/commands
- **Cosmetic**: JSDoc, formatting

### 3. Create a feature branch

```bash
git checkout -b ahp-package-upgrade-<version>
```

### 4. Bump the dependency

```bash
npm install @microsoft/agent-host-protocol@<version>
```

This updates `package.json` and `package-lock.json`. Verify the install:

```bash
node --input-type=module -e "import * as m from '@microsoft/agent-host-protocol'; console.log(m.PROTOCOL_VERSION, m.SUPPORTED_PROTOCOL_VERSIONS)"
```

### 5. Typecheck to find breakage

```bash
npx tsc --noEmit 2>&1
```

Fix every error systematically. The consumer areas most likely to break:

| Area | Files | What to check |
|------|-------|---------------|
| **State mirror** | `src/client/state.ts` | Reducer signatures, state shapes, channel routing (`session/`, `chat/`, `terminal/`, `root/`) |
| **Client API** | `src/client/index.ts` | Command params, imports |
| **SessionHandle** | `src/client/session-handle.ts` | `getSession`/`getChat` reads, action dispatch shapes |
| **TurnController** | `src/prompt/controller.ts` | Chat action handling, `getChat().activeTurn`, tool-call `contributor` |
| **Notifications** | `src/notifications.ts` | ahpx-local compat over the package's `*Params` (the package has no `type` discriminator) |
| **Customizations** | `src/customizations/types.ts`, `discovery.ts` | Mapping ahpx `CustomizationRef` → official `ClientPluginCustomization` |
| **Watcher** | `src/watch/watcher.ts` | Chat-state reads, action types |
| **CLI** | `src/bin.ts` | Turn display (`turn.message.text`), customization list/toggle |
| **Library exports** | `src/index.ts` | Re-exported types (some, e.g. `Customization`, are not root-exported — derive via `NonNullable<SessionState["customizations"]>[number]`) |

### 6. Inspect exact shapes from the installed package

Ground truth lives in the package's `.d.ts` files:

```
node_modules/@microsoft/agent-host-protocol/dist/types/channels-chat/state.d.ts
node_modules/@microsoft/agent-host-protocol/dist/types/channels-chat/actions.d.ts
node_modules/@microsoft/agent-host-protocol/dist/types/channels-session/state.d.ts
node_modules/@microsoft/agent-host-protocol/dist/types/channels-session/actions.d.ts
node_modules/@microsoft/agent-host-protocol/dist/types/index.d.ts   # what's re-exported from root
```

Get runtime enum values with:

```bash
node --input-type=module -e "import * as m from '@microsoft/agent-host-protocol'; console.log(m.ActionType.ChatDelta, m.MessageKind.User)"
```

### 7. Update the mock server and tests

`src/__tests__/helpers/mock-server.ts` emulates an AHP server — keep its
`PROTOCOL_VERSION`, snapshot shapes (session vs chat), and wire action strings in
sync with the new package. Then fix test fixtures and assertions.

### 8. Run all quality gates

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome (npm run lint:fix to auto-fix)
npm test            # vitest
npm run build       # tsup
```

### 9. Commit and open a PR

```bash
git add -A
git commit -m "feat: upgrade @microsoft/agent-host-protocol to <version>

<brief summary of breaking/additive changes adopted>

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push -u origin ahp-package-upgrade-<version>
gh pr create --title "feat: upgrade AHP package to <version>" --body "..."
```

## Skills to load

Before starting, load these project skills for context:

- `ahpx-architecture` — codebase structure and patterns
- `ahp-protocol` — protocol fundamentals (state model, channels, actions)

## Common pitfalls

1. **Session vs chat channel split**: turns/activeTurn live on `ChatState`
   (`getChat(uri)`), not `SessionState`. ahpx uses a one-session/one-chat model
   where the chat shares the session URI. Don't read turns off `getSession`.
2. **`const enum` values across the package boundary**: the package ships runtime
   objects for its const enums, so importing them as values works. But some types
   (e.g. `Customization`, `ToolCallContributorKind`) are NOT re-exported from the
   root — derive them from exported types or narrow structurally (`"clientId" in
   contributor`).
3. **Notifications carry no `type` field**: the package discriminates by JSON-RPC
   method. ahpx recreates a `type` discriminator in `src/notifications.ts` and the
   ProtocolLayer injects it. Keep that compat in sync.
4. **Biome lint**: run `npm run lint:fix` to auto-fix formatting and import order.
