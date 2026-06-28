---
description: >-
  Run a real end-to-end validation of ahpx against a live Agent Host server
  (e.g. the VS Code agent host) instead of mocks. Covers discovering the running
  server, bridging a Unix-socket host to the ws:// endpoint ahpx expects, and
  exercising the CLI + SDK turn flows with concrete assertions. Use when asked to
  validate ahpx against a real server or to re-run the live e2e suite.
---

# Live E2E Validation of ahpx

This is a repeatable procedure for validating ahpx against a **real** Agent Host
Protocol (AHP) server — not the mocked unit tests. It connects to a running
host, creates/resumes sessions, sends real agent interactions, and asserts the
responses are valid.

The codified harness lives at `e2e/cli.test.ts` (offline CLI surface). This skill
explains how to get a live server reachable plus the manual CLI smoke flow that
exercises the real protocol end-to-end.

> **Note:** ahpx is now a **CLI-only** wrapper around the official
> `@microsoft/agent-host-protocol` client and no longer exports an SDK. The old
> `e2e/sdk.test.ts` (which drove the deprecated `SessionHandle` SDK surface) was
> removed. Validate the live flow through the **CLI** (`exec`/`prompt`/`session`),
> which is the supported path.

## 1. Discover the running server

VS Code / VS Code Insiders runs an agent host as a **Unix domain socket**, not a
TCP port. Find the socket path from the running process:

```bash
ps aux | grep -o "agent-host-path [^ ]*" | head -1
# -> agent-host-path /var/folders/.../T/code-insiders-<uuid>
```

ahpx's configured servers live in `~/.ahpx/connections.json` (the default is
usually `insiders` = `ws://127.0.0.1:8090`). Confirm with:

```bash
node dist/bin.js server list
```

> The host speaks WebSocket over the socket. ahpx's `ws` transport supports
> `ws+unix://`, but `isValidWsUrl` (src/config/connections.ts) currently rejects
> non `ws:`/`wss:` schemes, so a Unix-socket host can't be targeted directly yet.
> Until that's relaxed, bridge the socket to a TCP port (next step).

## 2. Bridge the Unix socket to ws://127.0.0.1:8090

A raw byte pipe preserves the WebSocket upgrade handshake and framing untouched.
Save as `bridge.mjs`:

```js
import net from "node:net";
const SOCK = process.env.AHP_SOCK;
const PORT = Number(process.env.BRIDGE_PORT || 8090);
if (!SOCK) { console.error("AHP_SOCK env var required"); process.exit(1); }
const server = net.createServer((tcp) => {
  const unix = net.connect(SOCK);
  tcp.on("error", () => unix.destroy());
  unix.on("error", () => tcp.destroy());
  tcp.pipe(unix);
  unix.pipe(tcp);
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(`bridge listening on ws://127.0.0.1:${PORT} -> ${SOCK}`));
```

Run it (leave running in the background for the whole validation):

```bash
AHP_SOCK="/var/folders/.../T/code-insiders-<uuid>" BRIDGE_PORT=8090 node bridge.mjs &
```

Verify the server is actually up before testing:

```bash
node dist/bin.js server status
# Name=insiders  Status=healthy  Latency=~10ms  Agents=copilotcli, claude, codex
```

If status isn't `healthy`, stop — do not fake a pass.

## 3. Build ahpx

```bash
npm install
npm run build      # tsup -> dist/
```

## 4. Run the CLI smoke flow

```bash
# Connect / handshake (prints protocol version + agents + models)
node dist/bin.js connect insiders

# One-shot exec, NDJSON streaming, deterministic assertion
node dist/bin.js exec --format json -m gpt-5-mini \
  'Reply with exactly one word: PINEAPPLE'
# -> a turn_complete event whose responseText is "PINEAPPLE"

# Persistent multi-turn session (validates resume + first-delta recovery)
node dist/bin.js session new -n e2e-cli-verify
for w in PINEAPPLE BANANA ELEPHANT; do
  node dist/bin.js prompt -n e2e-cli-verify --format json \
    "Reply with exactly one word and nothing else: $w" \
    | grep -oE '"responseText":"[^"]*"'
done
# Each responseText must contain the FULL word (no dropped first character).
```

## 5. Live multi-turn CLI validation

ahpx no longer ships an SDK e2e suite. Validate the live protocol flow through
the CLI instead — it drives the same official client under the hood:

```bash
# Short + long replies, asserting full text in TEXT mode (folded-delta check)
for w in ELEPHANT BANANA "alpha bravo charlie delta echo"; do
  node dist/bin.js exec --approve-all "Reply with exactly: $w"
done
# Each reply must render in full (no dropped first character/chunk).

# Persistent session resume across multiple turns
node dist/bin.js session new -n e2e-cli-verify
for w in PINEAPPLE MANGO KIWI; do
  node dist/bin.js prompt -n e2e-cli-verify --format json \
    "Reply with exactly one word and nothing else: $w" \
    | grep -oE '"responseText":"[^"]*"'
done
```

## 6. Full quality gates

```bash
npm run typecheck
npm run lint
npx vitest run --exclude '**/e2e/**'   # unit suite (no live server needed)
```

## Protocol 0.5.0 gotchas this validation exposed

- **Separate chat channel.** A session's `defaultChat` MAY be a distinct
  `ahp-chat://` channel rather than the session URI. Turn/streaming actions,
  `turns`, `activeTurn`, and `steeringMessage` live on the **chat state**, not
  the session state. Code must subscribe to and dispatch turns on the chat
  channel. (See `resolveChatChannel` in `src/bin.ts` + `TurnController`.)
- **First-delta folding.** When a subscribe races with a turn start, the host
  MAY fold the first delta(s) into the subscribe snapshot's `activeTurn` instead
  of emitting them as `chat/delta` actions. Build the final response text from
  chat state `Turn.responseParts` at completion, not solely from streamed
  deltas, or you'll silently drop the first chunk.
- **Steering action shape.** `ChatPendingMessageSet` carries the content in a
  `message` field (a `Message`), **not** `userMessage`. A wrong field name is
  silently ignored by the host — the steering never takes effect and is never
  echoed.
- **Agent providers.** Real provider ids are host-specific (e.g. `copilotcli`,
  `claude`, `codex`), not `copilot`. The CLI defaults to the first advertised
  agent when none is specified — prefer that over hardcoding a provider.

## Reporting

Report concrete evidence: the exact commands, the server's actual output
(protocol version, responseText values, pass/fail counts), and whether each gate
passed. If something fails against the live server, that is a finding worth
reporting — capture it (issue + an e2e assertion) rather than faking a pass.

## Lessons learned (CLI-wrapper migration, June 2026)

Hard-won findings from validating ahpx live against a protocol-0.5.0 host while
reducing ahpx to a thin CLI wrapper around `@microsoft/agent-host-protocol`.

### Data layer vs. text renderer are two separate fixes

The folded-first-delta bug has **two halves**, and fixing one is not enough:

1. **Data layer** — `TurnController` must rebuild the authoritative response text
   from chat-state `Turn.responseParts` at turn completion (recovering any
   folded first delta the host never emitted as a `chat/delta`). JSON/quiet
   modes and persisted history read this layer, so they can look correct while
   text mode is still broken.
2. **Text renderer** — `PromptRenderer.onTurnComplete(responseText)` must
   actually *display* the authoritative text that wasn't already streamed. If it
   ignores that argument and prints only streamed deltas, short/folded replies
   render blank or truncated (ELEPHANT→blank, BANANA→"ANANA") **even though the
   data layer is correct**.

When validating, assert in **text mode** too — not just `--format json`. A JSON
pass can hide a renderer regression. The renderer tracks `streamedText` and on
completion emits only the remainder (`authoritative.startsWith(streamed)`),
recovering the folded prefix without duplicating already-streamed text.

### Version-bump-before-fix release trap

`0.2.31` was cut **before** the bug fixes landed, so the published version
advertised a fix it didn't contain — and `--version` itself was separately
hardcoded (`#87`). Two rules:

- `--version` must read the real `package.json` version (resolved via
  `import.meta.url` relative to the bundled `dist/bin.js`), never a literal.
  Test that it **equals** `package.json`'s version, not just that it's semver.
- **Never cut/publish a release before the fixes merge.** Merge fixes → then
  bump → then publish. Validate `node dist/bin.js --version` against the live
  build before trusting a release.

### Model selection: plumbing vs. host gap

`exec -m gpt-5-mini` reported usage for a *different* model. Wire tracing showed
ahpx sends the correct 0.5.0 shape — `message.model = { id: "gpt-5-mini" }` —
and `CreateSessionParams` has **no** model field (model is strictly per-message
in 0.5.0). The host (VS Code Insiders) simply **ignores** the per-message model
and returns its own default. So:

- This is a **host-side limitation**, not an ahpx plumbing bug. Don't chase it as
  a client fix — verify on the wire before concluding.
- The genuine ahpx bug was **precedence on resume**: a persisted session model
  shadowed an explicit `-m`. Correct order is
  `opts.model ?? sessionRecord?.model ?? cfg.defaultModel`.
- When validating model selection, distinguish "did the client send the right
  request?" (assert on the wire / NDJSON) from "did the host honor it?" (assert
  on `usage.model`). They can disagree.

### Tunnel resolution must cover health/status, not just connect

`server test`/`connect` resolved `tunnel://<id>` profiles to a `wss://` URL +
auth headers, but `server status`/`server health` passed the raw `tunnel://` URL
straight to the health checker — so every tunnel reported `unreachable` with a
URL/protocol error (`#88`). Any code path that takes a saved connection URL must
route tunnel profiles through the same resolver (and forward the tunnel auth
headers). A quick tell: after the fix, the error for a dead tunnel changes from a
URL-scheme/parse error to a real resolution result (e.g. `Tunnel "..." not
found.`), proving resolution now runs.

### Official-client deep-swap: validate the adapter, not just the CLI

ahpx's `src/client/*` core was replaced by the official
`@microsoft/agent-host-protocol` client behind a thin adapter (`AhpClient`
keeps its EventEmitter surface; internals call the official async-iterator
client). PRs #98 + #99 landed it; the dead high-level SDK
(`SessionHandle`/`ConnectionPool`/reconnect/active-client) was deleted. Lessons
for validating that swap live:

- **Folded-first-delta is THE regression check.** It survives the swap only
  because the adapter keeps ahpx's `StateMirror` (the official `AhpStateMirror`
  does **not** track `ahp-chat://` chat state) and `TurnController` still rebuilds
  responseText from `Turn.responseParts`. Always assert short single-word replies
  (ELEPHANT/BANANA/MANGO/KIWI) render IN FULL in **text mode** — that exercises
  the official client's `dispatch()` ordering (it calls `socket.send`
  synchronously before awaiting, so a `subscribe` immediately followed by a turn
  `dispatch` preserves frame order and the host still folds the first delta).
- **Gaps the adapter must keep** (don't expect the official client to cover):
  (1) WS **custom headers** for auth/tunnels → ahpx `WsTransport` over the `ws`
  package (the official `/ws` transport uses the header-less global WebSocket);
  (2) `ahp-chat://` chat state; (3) the EventEmitter bridge; (4) reverse-RPC file
  serving via `setServerRequestHandler`. If a future upgrade breaks one of these,
  the live symptom is usually a blank/truncated first reply or an auth failure on
  connect — not a unit-test failure.
- **Integration tests now drive the real CLI path.** `src/__tests__/integration/
  client.test.ts` runs the low-level client + real `TurnController` /
  `PromptRenderer` / `PermissionHandler` over a real-WS mock server. Tool
  approve/deny flow through `PermissionMode`; a turn that idles out
  (`state: "idle_timeout"`) is the signal that no confirmation was dispatched.
- **`npm version` vs biome.** `npm version <patch>` reflows `package.json`'s
  `files` array multi-line; biome's formatter wants it single-line, so the
  tag-driven publish pipeline's **lint gate fails** on the bump commit. After
  bumping, run `npx biome check --write package.json` (or just push a follow-up
  formatting commit and move the tag). The publish failed at lint *before*
  publishing, so re-pointing the tag was safe.
