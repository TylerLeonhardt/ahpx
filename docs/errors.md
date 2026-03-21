# Error Reference

Quick-reference for every error ahpx can produce — what it means and how to fix it.

---

## Exit Codes

| Code | Name               | Meaning                                                              |
| ---- | ------------------ | -------------------------------------------------------------------- |
| 0    | Success            | Command completed normally.                                          |
| 1    | Error              | General runtime error (unhandled exception, server-side failure).    |
| 2    | Usage              | Bad CLI arguments, missing required flags, or invalid option values. |
| 3    | Timeout            | Connection or session-readiness timed out.                           |
| 4    | NoSession          | No active session found for the given server/cwd/name.              |
| 5    | PermissionDenied   | All permission requests were denied by the user.                     |
| 130  | Interrupted        | Process received SIGINT (Ctrl-C).                                    |

---

## Error Classes

All structured errors extend `AhpxError`, which carries an `exitCode` that the CLI uses for `process.exitCode`.

### `AhpxError` (base)

```text
exitCode: varies (set by subclass or caller)
```

Base class. Thrown directly for general runtime failures such as:

- `Session creation failed: <reason>`
- `Connection "<name>" not found`
- `No server specified and no default is set.`

### `UsageError` → exit code 2

Thrown when CLI input is invalid before any work begins.

| Message pattern | Cause |
| --- | --- |
| `Invalid --tag format: "<entry>". Expected key=value` | `--tag` value missing `=` separator. |
| `--idle-timeout must be a positive integer (got: "<raw>")` | Non-numeric or negative idle timeout. |
| `--forward-headers must be a JSON object` | Value is not a `{...}` JSON object. |
| `--forward-headers must be valid JSON: <detail>` | Malformed JSON in `--forward-headers`. |
| `No agent provider available. Specify one with --provider.` | Server has no agents and `--provider` was omitted. |
| `No prompt text provided.` | `prompt` or `exec` command called without text. |
| `Failed to parse "<filePath>" as JSON.` | `session import` file is not valid JSON. |
| `Invalid session record: missing required fields (…)` | Imported record lacks `id`, `sessionUri`, etc. |
| `Invalid session record: status must be "active" or "closed".` | Imported record has a bad `status` value. |
| `Invalid session record: missing createdAt timestamp.` | Imported record lacks `createdAt`. |

### `TimeoutError` → exit code 3

Thrown when a deadline expires.

| Message pattern | Cause |
| --- | --- |
| `Timed out waiting for session to be ready` | Server did not emit `session/ready` within 30 s. |
| `Idle timeout: no events received for <N> seconds` | `--idle-timeout` elapsed with no server events. |
| `Connection to <url> timed out after <ms>ms` | WebSocket handshake exceeded `--timeout`. |

### `NoSessionError` → exit code 4

Thrown when a command needs an existing session but none can be found.

| Message pattern | Cause |
| --- | --- |
| `Session "<id>" not found.` | Explicit session ID does not exist in the local store. |
| `No active session found for <server> in <cwd>.` | No session matches the current server + working directory. |

> **Hint:** Run `ahpx session new` to create a session, or `ahpx session list` to see existing ones.

### `PermissionDeniedError` → exit code 5

Thrown when every permission request in a turn is denied (via `--deny-all` or interactive refusal).

| Message pattern | Cause |
| --- | --- |
| `All permissions denied by user` | User declined all tool/write permission prompts. |

---

## Common Error Messages

### 1. Connection Errors

#### `Connection to <url> timed out after <ms>ms`

**Cause:** The WebSocket handshake did not complete in time.
**Fix:** Check that the server is running and reachable. Increase timeout with `--timeout <ms>`.

#### `Connection to <url> failed: <detail>`

**Cause:** The WebSocket could not connect at all. Common `<detail>` values:

| Detail | Meaning |
| --- | --- |
| `ECONNREFUSED` | Nothing is listening on that host/port. |
| `ENOTFOUND` | DNS lookup failed — hostname is wrong. |
| `ECONNRESET` | Connection was forcibly closed by the remote side. |

**Fix:** Verify the server URL. Make sure the protocol is `ws://` or `wss://`, not `http://`.

#### `No server specified and no default is set.`

**Cause:** No `--server` flag, no `defaultServer` in config, and no default in the connection store.
**Fix:**

```bash
ahpx server add myserver --url ws://localhost:8080 --default
```

### 2. Authentication Errors

#### `Invalid token`

**Cause:** The auth token sent to the server was rejected.
**Fix:** Regenerate or update the token:

```bash
ahpx server add myserver --url ws://... --token <new-token> --default
```

#### Server-initiated `authRequired` notification

**Cause:** The server requested authentication mid-session. ahpx's `AuthHandler` attempts to satisfy it automatically. If it fails, the server will retry or return an error on the next RPC call.
**Fix:** Ensure the connection profile has a valid `--token`.

### 3. Session Errors

#### `Session "<id>" not found.`

**Cause:** The session ID passed to `session resume`, `prompt`, `cancel`, etc. does not exist in the local session store.
**Fix:** Run `ahpx session list` to see available sessions. Create a new one with `ahpx session new`.

#### `No active session found for <server> in <cwd>.`

**Cause:** ahpx scopes sessions by server + working directory. No active session matches.
**Fix:** `cd` into the correct directory, or specify `--session-name` / a session ID explicitly.

#### `Session creation failed: <reason>`

**Cause:** The server acknowledged the `createSession` request but reported a failure (e.g., provider crashed, resource limit).
**Fix:** Check server logs. Try a different `--provider` or `--model`.

#### `Timed out waiting for session to be ready`

**Cause:** The server did not emit a `session/ready` action within 30 seconds.
**Fix:** The server may be overloaded. Retry, or check server health with `ahpx server health <name>`.

#### `SessionHandle has been disposed`

**Cause:** Code attempted to use a session handle after it was already cleaned up (internal lifecycle bug or race).
**Fix:** This is typically an internal error. File a bug if reproducible.

### 4. Configuration Errors

#### `Unknown connection "<name>".`

**Cause:** The `--server` flag references a name not in `~/.ahpx/connections.json`.
**Fix:**

```bash
ahpx server list          # see what's saved
ahpx server add <name> --url ws://...
```

#### `Default server "<name>" not found in connections.`

**Cause:** `defaultServer` in your config points to a connection name that no longer exists.
**Fix:** Re-add the connection or update `defaultServer`:

```bash
ahpx config set defaultServer <existing-name>
```

#### `Connection "<name>" already exists`

**Cause:** `ahpx server add` was called with a name that is already saved.
**Fix:** Remove the old one first, or choose a different name:

```bash
ahpx server remove <name>
ahpx server add <name> --url ws://...
```

#### `Invalid WebSocket URL: <url> (must be ws:// or wss://)`

**Cause:** The URL passed to `server add` uses `http://` or another unsupported scheme.
**Fix:** Change the protocol to `ws://` (or `wss://` for TLS).

### 5. Permission Errors

#### `All permissions denied by user`

**Cause:** During an interactive turn, every tool-call or file-write permission was declined.
**Fix:** Re-run and approve at least one permission, or use `--approve-reads` / `--approve-all` if appropriate.

#### Permission flags

| Flag | Effect |
| --- | --- |
| `--approve-all` | Auto-approve all tool calls and writes. |
| `--approve-reads` | Auto-approve read-only tool calls; prompt for writes. |
| `--deny-all` | Deny everything (useful for dry-run / CI). |

---

## Connection Troubleshooting

If you can't connect to a server, walk through these steps in order:

### 1. Check the server is running

```bash
# If you control the server process:
ps aux | grep ahp        # or your server process name
```

### 2. Check the URL is correct

The URL **must** use `ws://` or `wss://`, not `http://`.

```bash
ahpx server list         # verify the saved URL
ahpx connect ws://localhost:8080   # test with a direct URL
```

### 3. Check the auth token

```bash
# Re-add with the correct token:
ahpx server remove myserver
ahpx server add myserver --url ws://localhost:8080 --token <token> --default
```

### 4. Try with `--verbose`

```bash
ahpx connect myserver --verbose
```

Verbose mode prints the full error stack trace, which often reveals the underlying OS error code (`ECONNREFUSED`, `ENOTFOUND`, etc.).

### 5. Check firewall / proxy

- Ensure your firewall allows outbound WebSocket connections on the target port.
- If behind a corporate proxy, make sure it supports WebSocket upgrades (`HTTP 101`).
- For `wss://` connections, verify the TLS certificate is trusted.

---

## JSON Output Mode Errors

When `--format json` is active, **all errors** are emitted as a single JSON object on stdout instead of the normal `✗ <message>` on stderr.

### Envelope shape

```jsonc
{
  "error": "<error message string>",
  "exitCode": <number>
}
```

### Example

```bash
$ ahpx connect bad-server --format json
{"error":"Unknown connection \"bad-server\". Run ahpx server list to see saved connections.","exitCode":1}
$ echo $?
1
```

### Notes

- `error` is always a string (the `.message` property of the thrown error).
- `exitCode` matches the process exit code (see the [Exit Codes](#exit-codes) table).
- In `--format quiet` mode, output is suppressed **unless** the exit code is non-zero.
- In `--verbose` mode (any format), the full stack trace is printed to stderr.
