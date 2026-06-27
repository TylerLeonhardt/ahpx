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

The codified harness lives at `e2e/sdk.test.ts` (SDK path, server-gated) and
`e2e/cli.test.ts` (offline CLI surface). This skill explains how to get a live
server reachable so the SDK suite actually runs, plus the manual CLI smoke flow.

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

## 5. Run the live SDK e2e suite

With the bridge up, the server-gated suite runs automatically (it self-skips if
`ws://127.0.0.1:8090` is unreachable):

```bash
npx vitest run e2e/sdk.test.ts
# Expect: 3 passed (send prompt, steering mid-turn, observe state mid-stream)
```

Run it 2–3 times to confirm it's stable (turn streaming can be timing-sensitive).

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
  channel. (See `SessionHandle` / `TurnController` `resolveChatChannel`.)
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
  `claude`, `codex`), not `copilot`. Prefer `client.openSession()` (defaults to
  the first advertised agent) over hardcoding a provider.

## Reporting

Report concrete evidence: the exact commands, the server's actual output
(protocol version, responseText values, pass/fail counts), and whether each gate
passed. If something fails against the live server, that is a finding worth
reporting — capture it (issue + an e2e assertion) rather than faking a pass.
