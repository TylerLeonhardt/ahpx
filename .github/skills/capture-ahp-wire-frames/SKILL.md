---
description: >-
  Capture the EXACT JSON-RPC frames ahpx exchanges with an Agent Host by
  inserting a transparent WebSocket "tee" proxy between ahpx and the real host.
  Covers pointing ahpx at an isolated HOME whose default server targets the tee
  port, running scripts/ahp-wire-tee.mjs to log every C->S / S->C frame as NDJSON,
  driving ahpx (exec / session new) through it, and extracting/inspecting specific
  payloads (dispatchAction, the initialize response, agent/model advertisements)
  with node -e filters — then comparing them against the @microsoft/agent-host-protocol
  type contract. Use when a protocol mystery needs proof of what ahpx actually
  sends vs. what the host returns (client bug vs. host bug).
---

# Capture AHP Wire Frames

When a protocol question is "does ahpx send the right bytes, or is the host
misbehaving?", **don't reason about it — capture it.** This skill inserts a
transparent WebSocket *tee* proxy between ahpx and the Agent Host so you can read
the EXACT JSON-RPC frames in both directions, then compare them against the
`@microsoft/agent-host-protocol` type contract.

```
ahpx ──ws──▶ tee (127.0.0.1:8099) ──ws──▶ host (127.0.0.1:8090)
                    │
                    └── logs every frame: direction + timestamp + parsed JSON
```

This is exactly how we proved that ahpx's per-message model plumbing was
spec-correct (`dispatchAction` → `chat/turnStarted` → `message.model = { id:
"gpt-5.5" }`) and the dropped model was a **host-side** limitation, not an ahpx
bug. The decisive evidence was the captured frame, not an argument.

> **Decide client-vs-host on the wire.** "Did the client send the right request?"
> is answered by the **C->S** frame. "Did the host honor it?" is answered by the
> **S->C** frame (and `usage.model`). They can disagree — capture both.

## The committed helper

The tee proxy is a permanent, parameterized script:
[`scripts/ahp-wire-tee.mjs`](../../../scripts/ahp-wire-tee.mjs). It relays each
WebSocket message verbatim (byte-faithful framing) and only *parses a copy* for
logging, so it never alters what ahpx sends or what the host returns.

```bash
node scripts/ahp-wire-tee.mjs \
  --listen 8099 \
  --target ws://127.0.0.1:8090 \
  --log /tmp/ahpx-wire/frames.ndjson
# env equivalents (flags win): TEE_LISTEN_PORT / TEE_TARGET_URL / TEE_LOG_PATH
```

Each NDJSON line is `{ ts, direction: "C->S"|"S->C", summary, json }` (with a
`raw` string fallback for non-JSON frames). `summary` is the JSON-RPC `method`
or `response#<id>` for quick scanning.

## Posture (read this first)

- **Isolated HOME — never touch `~/.ahpx`.** ahpx reads connections from
  `$HOME/.ahpx/connections.json` (see `ConnectionStore` in
  `src/config/connections.ts`, which defaults to `os.homedir()/.ahpx`). Point it
  at a throwaway HOME so capture runs can't mutate your real connections,
  sessions, or config.
- **Read-only by default.** Drive ahpx with `--approve-reads` (the default
  permission mode) so a captured session can't perform writes. Only use
  `--approve-all` if the mystery specifically requires a write/tool turn.
- **Clean up.** Remove the temp HOME, the NDJSON log, and any sessions you
  created when you're done. Stop the tee proxy (`kill <pid>`).

## 1. Get the real host reachable on a TCP port

ahpx's tee target is a `ws://` URL. If the host is already a TCP WebSocket on
`ws://127.0.0.1:8090`, skip to step 2. If it's a VS Code Unix-domain socket,
bridge it to `8090` first — see the **live-e2e-validation** skill (`bridge.mjs`).
Either way, the tee's `--target` is the real host; the tee's `--listen` port
(8099) is what ahpx connects to.

## 2. Stand up an isolated HOME pointed at the tee

```bash
export TEE_HOME="$(mktemp -d)"
mkdir -p "$TEE_HOME/.ahpx"
cat > "$TEE_HOME/.ahpx/connections.json" <<'JSON'
{
  "connections": [
    { "name": "tee", "url": "ws://127.0.0.1:8099", "default": true }
  ]
}
JSON
```

ahpx now resolves the **default** server to the tee port — every command run
with `HOME="$TEE_HOME"` flows through the proxy without any extra flags.

## 3. Start the tee proxy (leave it running)

```bash
export WIRE_LOG="$TEE_HOME/frames.ndjson"
node scripts/ahp-wire-tee.mjs --listen 8099 --target ws://127.0.0.1:8090 --log "$WIRE_LOG" &
TEE_PID=$!
# Wait for: "ahp-wire-tee listening on ws://127.0.0.1:8099 -> ws://127.0.0.1:8090"
```

## 4. Drive ahpx through the proxy

Build first if needed (`npm run build`), then run ahpx with the isolated HOME.

```bash
# One-shot turn — captures initialize, agent/model advertisement, and the
# dispatchAction that starts the turn.
HOME="$TEE_HOME" node dist/bin.js exec --approve-reads -m gpt-5.5 \
  'Reply with exactly one word: PINEAPPLE'

# Or a persistent session (captures createSession + subscribe + dispatch):
HOME="$TEE_HOME" node dist/bin.js session new -n wire-probe
HOME="$TEE_HOME" node dist/bin.js prompt -n wire-probe --approve-reads \
  'Reply with exactly one word: BANANA'
```

## 5. Extract and inspect specific frames

The log is NDJSON — filter it with `node -e`. Useful one-liners:

```bash
# Every frame, one line each: timestamp, direction, method/summary
node -e 'require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").forEach(l=>{const f=JSON.parse(l);console.log(f.ts,f.direction,f.summary)})' "$WIRE_LOG"

# The dispatchAction payloads ahpx sent (proves the per-message model shape)
node -e 'require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l)).filter(f=>f.direction==="C->S"&&f.json?.method==="dispatchAction").forEach(f=>console.log(JSON.stringify(f.json.params,null,2)))' "$WIRE_LOG"

# The initialize response from the host (protocol version, capabilities)
node -e 'const a=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l));const init=a.find(f=>f.direction==="C->S"&&f.json?.method==="initialize");const res=a.find(f=>f.direction==="S->C"&&f.json?.id===init?.json?.id);console.log(JSON.stringify(res?.json?.result,null,2))' "$WIRE_LOG"

# Agent / model advertisements anywhere in the capture
node -e 'require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l)).forEach(f=>{const s=JSON.stringify(f.json);if(/"agents"|"models"|"providers"/.test(s))console.log(f.direction,f.summary,s)})' "$WIRE_LOG"
```

For the per-message model proof specifically, look inside the `dispatchAction`
whose action is `chat/turnStarted` (or the chat-channel turn-start action) and
confirm `message.model` is `{ id: "<model>" }` — model is **per-message** in
0.5.0, not on `CreateSessionParams`.

## 6. Compare against the protocol type contract

The captured shapes must match the official types in
`node_modules/@microsoft/agent-host-protocol/dist/types/`. The package is
**channel-split** — actions/commands live under per-channel folders, not one
flat file:

```
dist/types/
  actions.d.ts            # top-level action envelope / union
  commands.d.ts           # JSON-RPC command params (dispatchAction, subscribe, …)
  state.d.ts              # state snapshots
  channels-chat/          # chat turn/delta/steering actions  ← message.model lives here
  channels-root/          # initialize / agents / server-level
  channels-session/       # session lifecycle
  channels-resource-watch/, channels-terminal/, channels-otlp/, …
```

Match a captured frame to its type:

```bash
# Where is the chat turn-start action defined? (confirms message.model field)
grep -rn "turnStarted\|model" node_modules/@microsoft/agent-host-protocol/dist/types/channels-chat/actions.d.ts

# What does dispatchAction's params type require?
grep -rn "dispatchAction\|DispatchAction" node_modules/@microsoft/agent-host-protocol/dist/types/commands.d.ts

# initialize / agent advertisement contract
grep -rn "initialize\|agents\|providers" node_modules/@microsoft/agent-host-protocol/dist/types/channels-root/
```

If the C->S frame matches the type and the host still misbehaves, the bug is
**host-side** — record it as a finding, not an ahpx fix. If the frame *doesn't*
match the type, you've found the ahpx bug, and the captured payload is the
regression test fixture.

## 7. Clean up

```bash
kill "$TEE_PID" 2>/dev/null
HOME="$TEE_HOME" node dist/bin.js session rm wire-probe 2>/dev/null || true
rm -rf "$TEE_HOME"
```

Never leave the temp HOME or the throwaway `tee` connection in your real
`~/.ahpx`.

## Why a tee (not the existing raw-WS debug script)

`scripts/debug-resolveSessionConfig.mjs` hand-crafts the frames *it* thinks
VS Code sends. The tee captures the frames **ahpx actually sends** in a real run
— including ordering effects (e.g. the official client calls `socket.send`
synchronously before awaiting, so `subscribe` immediately followed by a turn
`dispatch` preserves frame order and the host may fold the first delta). When the
question is "what does ahpx put on the wire?", capture beats reconstruction.
