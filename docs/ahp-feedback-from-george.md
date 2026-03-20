# AHP Protocol Feedback (from George Integration)

Collected during George's AgentDispatcherV3 integration with ahpx.

## What Works in the Protocol

### Session lifecycle
`createSession` / `disposeSession` / `listSessions` provide clean lifecycle
control. Session URI scheme gives clients full identity control.

### Streaming and observation
Action-based streaming (`session/delta`, `session/toolCallStart`, etc.) works
well for both interactive and non-interactive dispatch. George's watcher can
subscribe and monitor progress without participating in permissions.

### Reconnection
`reconnect` with `lastSeenServerSeq` and action replay handles dropped
connections gracefully. Dispatch processes survive transient network issues.

### Working directory support
`ICreateSessionParams.workingDirectory` (added via `--cwd` in PR #33) lets
George scope agents to specific project directories.

## What the Protocol Needs

### Gap: System Prompt / Agent Instructions on Session Creation

**What George needs:**
A way to set agent instructions (system prompt) when creating a session,
separate from the user message. George wants `--system <text>` or
`--system-file <path>` to configure agent persona and cultural identity
(e.g., "You are a senior engineer on project X, follow these coding standards").

**What the protocol supports:**
`ICreateSessionParams` accepts only:
- `session` (URI)
- `provider` (string)
- `model` (string)
- `workingDirectory` (string)

There is no `instructions`, `systemPrompt`, or equivalent field.

**Current workaround:**
George prepends instructions to the first user message, which conflates
configuration with conversation. This breaks when:
- The agent summarizes the turn (includes instructions in the summary)
- George wants to reuse a session with different user prompts but the same persona
- The system prompt is long and wastes context window on subsequent turns

**Suggested protocol change:**
Add an optional `instructions` field to `ICreateSessionParams`:

```typescript
export interface ICreateSessionParams {
  session: URI;
  provider?: string;
  model?: string;
  workingDirectory?: string;
  instructions?: string;  // <-- new: system prompt / agent instructions
}
```

The server would treat `instructions` as persistent system-level context for
the session, separate from user messages. This is analogous to the `system`
parameter in most LLM APIs.

**Impact:** High. This is the most requested feature from George's team. Every
dispatch job needs agent instructions, and the current workaround degrades
quality.
