# ahpx v0.2 Roadmap

> **⚠️ Historical document.** This roadmap captures the v0.2 plan as it was
> conceived, including "Library Mode" (Phase 7). **Direction has since changed:**
> ahpx is now a **CLI-only thin wrapper** around the official
> [`@microsoft/agent-host-protocol`](https://www.npmjs.com/package/@microsoft/agent-host-protocol)
> client and **no longer ships an exported SDK**. References to "library mode",
> `import { AhpClient } from '@tylerl0706/ahpx'`, and a public TypeScript API
> below are retained for historical context only and no longer reflect the
> shipped package. See the README and `docs/user-guide.md` for current
> architecture.

> **Vision (original):** ahpx evolves from a CLI tool to a production-grade agent
> dispatch platform — usable as a Node.js library, capable of managing fleets of
> AHP servers, and reliable enough to run autonomous agent workflows at scale.

## Where we are

ahpx v0.1 shipped 6 phases: core AHP client, connection management, session
lifecycle, prompting with streaming, output formatting, multi-client observation,
and George integration. **229 tests pass.** It's integrated into
[George](https://github.com/TylerLeonhardt/copilot-chat-bridge) as
AgentDispatcherV3, dispatching agents through AHP servers with structured NDJSON
output and semantic exit codes.

v0.1 proved the architecture works. v0.2 makes it production-ready.

## Priorities

The phases are ordered by dependency and value. Each phase builds on the
previous, and the ordering reflects what unblocks the most downstream work:

1. **Library Mode** — unlocks programmatic use (everything else benefits)
2. **Multi-Session** — enables concurrent agent management
3. **Event Forwarding** — enables dashboard and monitoring integrations
4. **Fleet Management** — enables multi-server dispatch at scale
5. **Robust Multi-Turn** — enables complex, long-running agent tasks
6. **Production Hardening** — fixes bugs, adds tests, ships with confidence

---

## Phase 7: Library Mode

**Goal:** Export ahpx as a Node.js library, not just a CLI.

### Why this is first

Today ahpx is CLI-only — George spawns a child process and parses stdout. This
works, but it's brittle: process management overhead, stdout parsing fragility,
no type safety for consumers. The client code in `src/client/` is already
well-architected (`AhpClient`, `Transport`, `ProtocolLayer`, `StateMirror`) but
isn't exported. Exposing it as a library unlocks every subsequent phase for
programmatic consumers.

### What to build

- Create `src/index.ts` that re-exports the client API (`AhpClient`,
  `StateMirror`, `TurnController`, types)
- Add `exports` field to `package.json`:
  ```json
  { ".": "./dist/index.js", "./cli": "./dist/bin.js" }
  ```
- Update tsup to build two entry points: `src/index.ts` (library) and
  `src/bin.ts` (CLI)
- Export TypeScript type declarations (`.d.ts`) for consumers
- Set default permission mode to `approve-all` for library/non-interactive use
  (#7)
- Add library usage examples to README (#9)
- Publish to npm as `ahpx` (library + CLI in one package)

### Acceptance criteria

- [ ] `import { AhpClient } from '@tylerl0706/ahpx'` works with full type safety
- [ ] `npx ahpx connect ws://...` still works (CLI preserved)
- [ ] Library consumers can connect, create sessions, send prompts, and
      receive typed events without touching the CLI
- [ ] TypeScript declarations are correct and complete
- [ ] README includes a working library example
- [ ] Non-interactive (no TTY) defaults to `approve-all` permissions

### Issues

| Issue | Title |
|-------|-------|
| [#7](https://github.com/TylerLeonhardt/ahpx/issues/7) | CLI: Default permission mode should be approve-all for non-interactive use |
| [#9](https://github.com/TylerLeonhardt/ahpx/issues/9) | Docs: README needs real usage examples with a VS Code AHP server |

### Dependencies

None — this is pure packaging and export work on existing code.

---

## Phase 8: Multi-Session Connections

**Goal:** One WebSocket connection, multiple concurrent sessions.

### Why

AHP supports multiple sessions on a single connection. ahpx should expose this
cleanly — both for the CLI (managing multiple agents on one server) and for
library consumers (running concurrent agent tasks without connection overhead).

### What to build

- `AhpClient` already supports multiple sessions internally — expose it
  properly in the library API with a clean session handle abstraction
- Library: `client.createSession()` returns a typed session handle; multiple
  sessions share one connection
- CLI: `ahpx session new` + `ahpx prompt -n <name>` already works —
  ensure it's robust for concurrent use
- Add `ahpx sessions active` to show all active sessions on a server
- Connection pooling: reuse connections to the same server URL

### Acceptance criteria

- [ ] Library consumers can create 3+ sessions on one client connection
- [ ] Each session receives only its own events (no cross-talk)
- [ ] `ahpx sessions active` lists all active sessions with server info
- [ ] Connection pooling reuses WebSocket connections to the same URL
- [ ] Session disposal properly cleans up without affecting other sessions

### Issues

| Issue | Title |
|-------|-------|
| [#31](https://github.com/TylerLeonhardt/ahpx/issues/31) | Protocol gap: Session transfer relies on implicit mechanisms |

### Dependencies

- Phase 7 (Library Mode) — session handles need to be part of the public API
- **Protocol note:** Session transfer (#31) relies on implicit mechanisms in the
  AHP protocol. ahpx can implement connection sharing, but true session transfer
  between clients requires protocol changes.

---

## Phase 9: Event Forwarding & Dashboard Integration

**Goal:** Forward NDJSON events to external consumers beyond stdout.

### Why

For George Dashboard integration and agent-to-agent communication, events need
to flow somewhere beyond stdout. The `JsonFormatter` already produces clean
NDJSON — this phase adds forwarding targets.

### What to build

- `--forward <url>` flag: POST NDJSON events to a webhook URL
- `--forward-ws <url>` flag: stream events over a WebSocket connection
- Library API: `client.on('action', callback)` already works — document it
  and ensure the event types are fully exported
- Event buffering: if the forward target is temporarily down, buffer events in
  memory and retry with backoff
- Configurable event filtering: `--forward-types delta,tool_call_complete,turn_complete`
  to forward only specific event types
- Pipe mode (#8): enable `ahpx` output to be consumed by another `ahpx`
  instance or external tooling

### Acceptance criteria

- [ ] `ahpx exec --forward http://dashboard/events` POSTs each NDJSON event
- [ ] `ahpx exec --forward-ws ws://dashboard/stream` streams events in real-time
- [ ] Forwarding failures don't crash the session — events are buffered and
      retried
- [ ] Event type filtering works (e.g., forward only `turn_complete`)
- [ ] Library API emits all events with proper TypeScript types

### Issues

| Issue | Title |
|-------|-------|
| [#8](https://github.com/TylerLeonhardt/ahpx/issues/8) | Feature: ahpx should support a 'pipe mode' for agent-to-agent communication |

### Dependencies

- Phase 7 (Library Mode) — event types must be exported
- No AHP protocol changes required — this is pure client-side forwarding

---

## Phase 10: Fleet Management

**Goal:** Manage multiple AHP servers and dispatch intelligently.

### Why

Production deployments run multiple AHP servers. ahpx needs to track server
health, route dispatches to available capacity, and support server grouping for
different workloads.

### What to build

- `ahpx server status` — health check all saved servers (concurrent
  connections, available agents, latency)
- `ahpx server health <name>` — detailed health for one server (uptime,
  session count, error rate)
- Library API: `FleetManager` class that tracks server health and routes
  dispatches to the best available server
- Capacity-aware routing: prefer servers with fewer active sessions and lower
  latency
- Server groups: tag servers (e.g., `"local"`, `"cloud"`, `"gpu"`) for dispatch
  policies
- Agent health monitoring: detect unresponsive agents via inactivity tracking
  (#28)

### Acceptance criteria

- [ ] `ahpx server status` shows health summary for all saved servers
- [ ] `FleetManager` automatically routes to the healthiest server
- [ ] Server groups work: `ahpx exec -g cloud "deploy the app"` dispatches to
      a cloud-tagged server
- [ ] Capacity-aware routing prefers servers with fewer active sessions
- [ ] Agent inactivity detection flags potentially crashed agents

### Issues

| Issue | Title |
|-------|-------|
| [#28](https://github.com/TylerLeonhardt/ahpx/issues/28) | Protocol gap: No agent crash detection or health signaling |
| [#30](https://github.com/TylerLeonhardt/ahpx/issues/30) | Protocol gap: Authentication model lacks service identity support |

### Dependencies

- Phase 7 (Library Mode) — `FleetManager` is a library-level API
- Phase 8 (Multi-Session) — fleet routing creates sessions on different servers
- **Protocol note:** Agent crash detection (#28) has no protocol support.
  ahpx can implement client-side heuristics (inactivity timeouts, heartbeat
  monitoring) but can't definitively detect server-side crashes without protocol
  changes.
- **Protocol note:** Service identity (#30) requires protocol-level auth changes.
  ahpx can support per-server tokens as a workaround.

---

## Phase 11: Robust Multi-Turn Sessions

**Goal:** Reliable persistent sessions for complex, long-running tasks.

### Why

Real-world agent workflows span hours, involve disconnections, and need session
metadata for tracking. This phase makes sessions resilient and full-featured.

### What to build

- Session resume after disconnect: ahpx reconnects and replays missed actions
  (#10)
- `ahpx prompt` with session persistence across CLI invocations (resume where
  you left off)
- `--wait-for-ready` flag on `ahpx session new` to block until session is fully
  initialized (#6)
- Session metadata: attach job IDs, user context, and custom tags to sessions
  (#5, #26)
- System prompt support: `--system <text>` and `--system-file <path>` to
  configure agent persona at session creation (#25)
- Session history: `ahpx session history <id>` shows full conversation
- Session fork: create a new session from an existing one's state (when AHP
  supports it)
- Session export/import: save/load session state for debugging

### Acceptance criteria

- [ ] Session resumes automatically after network disconnection
- [ ] `ahpx session new --wait-for-ready` blocks until session accepts prompts
- [ ] `ahpx session new --system "You are a code reviewer"` sets agent persona
- [ ] Session metadata (job ID, tags) persists and is queryable
- [ ] `ahpx session history <id>` shows complete turn history
- [ ] Session export produces a self-contained JSON for debugging

### Issues

| Issue | Title |
|-------|-------|
| [#5](https://github.com/TylerLeonhardt/ahpx/issues/5) | Feature: Job/task tracking for dispatched work |
| [#6](https://github.com/TylerLeonhardt/ahpx/issues/6) | CLI: Need a --wait-for-ready flag or auto-wait on session new |
| [#10](https://github.com/TylerLeonhardt/ahpx/issues/10) | Feature: Session resume/reattach after disconnect |
| [#25](https://github.com/TylerLeonhardt/ahpx/issues/25) | Protocol gap: No system prompt or agent persona configuration in createSession |
| [#26](https://github.com/TylerLeonhardt/ahpx/issues/26) | Protocol gap: No custom metadata on sessions |
| [#29](https://github.com/TylerLeonhardt/ahpx/issues/29) | Protocol gap: Working directory semantics undefined |

### Dependencies

- Phase 7 (Library Mode) — session handles must support metadata
- **Protocol note:** System prompt (#25) has no protocol support. ahpx can
  implement a client-side workaround by prepending system instructions to the
  first user message. This is a known token-inefficient workaround — when the
  protocol adds `instructions` to `ICreateSessionParams`, ahpx should switch.
- **Protocol note:** Custom metadata (#26) has no protocol support. ahpx can
  implement client-side metadata storage in the `SessionStore`, but this
  metadata won't be visible to the server or other clients.
- **Protocol note:** Working directory (#29) is advisory-only in the protocol.
  ahpx can't enforce sandboxing — it can only pass the working directory hint.
- **Protocol note:** Session fork requires protocol support that doesn't exist
  yet. Include in the design but mark as "pending protocol support."

---

## Phase 12: Production Hardening

**Goal:** Ready for real-world autonomous dispatch. Ship with confidence.

### Why

Before ahpx can be trusted for production autonomous dispatch, it needs bug
fixes, comprehensive tests, CI/CD, error handling improvements, and operational
hardening. This phase is about **reliability and trust**.

### What to build

#### Bug fixes
- Fix globalConfigDir() HOME path handling (#13)
- Fix lint violations in Phase 5 code (#12)
- Fix watcher test failures (#11)

#### Testing
- Add tests for `connect-helper.ts` (#16)
- Add CLI integration tests for `bin.ts` — ~1,900 lines currently untested (#17)
- Build a mock AHP server for real end-to-end tests (not just unit tests)
- Target: confident enough to deploy after a green test run

#### Code quality
- Fix `getOriginLabel()` stub that returns empty string (#18)
- Add runtime validation for JSON-parsed config and session data (#19)
- Use tool annotations in permission handler `approve-reads` mode (#20)
- Share command lists between shell completions and CLI parser (#21)
- Fix corrupt JSON file handling — warn instead of silently skipping (#15)
- Set restrictive file permissions on config and session files (#14)

#### Error handling & resilience
- Implement turn retry mechanism with error taxonomy (#27)
- Rate limiting and backpressure handling
- Graceful degradation when server is overloaded
- Comprehensive error catalog with user-facing documentation

#### CI/CD
- GitHub Actions workflow: test, lint, typecheck, build on PRs
- npm publish workflow (manual trigger for releases)
- Branch protection on `master`

### Acceptance criteria

- [ ] All 3 open bugs (#11, #12, #13) are fixed
- [ ] `connect-helper.ts` and `bin.ts` have test coverage
- [ ] End-to-end tests run against a mock AHP server
- [ ] CI pipeline runs on every PR (test + lint + typecheck + build)
- [ ] npm publish workflow publishes to npm registry
- [ ] Transient errors are automatically retried with backoff
- [ ] All config/session files have restrictive permissions (0600)
- [ ] Error catalog documents every exit code and error type

### Issues

| Issue | Title | Category |
|-------|-------|----------|
| [#11](https://github.com/TylerLeonhardt/ahpx/issues/11) | Watcher tests: 6 timeout failures and 2 type errors break CI | Bug |
| [#12](https://github.com/TylerLeonhardt/ahpx/issues/12) | Lint violations in Phase 5 code (19 errors, 10 warnings) | Bug |
| [#13](https://github.com/TylerLeonhardt/ahpx/issues/13) | Config: globalConfigDir() uses process.env.HOME with broken ~ fallback | Bug |
| [#14](https://github.com/TylerLeonhardt/ahpx/issues/14) | Security: Config and session files created without restrictive permissions | Security |
| [#15](https://github.com/TylerLeonhardt/ahpx/issues/15) | Corrupt JSON files silently skipped with no warning | Quality |
| [#16](https://github.com/TylerLeonhardt/ahpx/issues/16) | No tests for connect-helper.ts | Testing |
| [#17](https://github.com/TylerLeonhardt/ahpx/issues/17) | No CLI integration tests for bin.ts (~1,900 lines untested) | Testing |
| [#18](https://github.com/TylerLeonhardt/ahpx/issues/18) | Watcher: getOriginLabel() is stubbed, returns empty string | Quality |
| [#19](https://github.com/TylerLeonhardt/ahpx/issues/19) | No runtime validation on JSON-parsed config and session data | Quality |
| [#20](https://github.com/TylerLeonhardt/ahpx/issues/20) | Permission handler approve-reads mode doesn't use tool annotations | Quality |
| [#21](https://github.com/TylerLeonhardt/ahpx/issues/21) | Shell completions hard-code command lists instead of sharing with CLI parser | Quality |
| [#27](https://github.com/TylerLeonhardt/ahpx/issues/27) | Protocol gap: No turn retry mechanism or error taxonomy | Resilience |

### Dependencies

- **No hard dependencies** on earlier phases — bug fixes and testing can start
  immediately. However, CI/CD and npm publish workflows benefit from Phase 7
  (Library Mode) being complete first so the build pipeline covers both entry
  points.
- **Protocol note:** Turn retry (#27) error taxonomy requires protocol changes
  for full support. ahpx can implement client-side heuristics (retry on
  connection errors, timeout errors) without protocol changes.

---

## Protocol dependency summary

Several issues are tagged `protocol-feedback` — these require changes to the
AHP protocol itself, not
just ahpx. The table below shows what ahpx can do now vs. what requires
upstream protocol changes.

| Issue | Protocol Gap | ahpx Workaround | Needs Protocol Change? |
|-------|-------------|-----------------|----------------------|
| [#25](https://github.com/TylerLeonhardt/ahpx/issues/25) | No system prompt | Prepend to first user message | Yes — `instructions` field on `ICreateSessionParams` |
| [#26](https://github.com/TylerLeonhardt/ahpx/issues/26) | No session metadata | Client-side metadata store | Yes — `metadata` field on `ISessionSummary` |
| [#27](https://github.com/TylerLeonhardt/ahpx/issues/27) | No retry taxonomy | Client-side error classification | Yes — `retryable` field on error responses |
| [#28](https://github.com/TylerLeonhardt/ahpx/issues/28) | No crash detection | Inactivity timeout heuristics | Yes — heartbeat/health protocol |
| [#29](https://github.com/TylerLeonhardt/ahpx/issues/29) | Working dir advisory | Pass hint, document limitation | Yes — sandboxing semantics |
| [#30](https://github.com/TylerLeonhardt/ahpx/issues/30) | No service identity | Per-server token config | Yes — service account auth |
| [#31](https://github.com/TylerLeonhardt/ahpx/issues/31) | Implicit transfer | Connection sharing | Yes — explicit claim command |

**Strategy:** Implement client-side workarounds where feasible. Document
limitations clearly. Remove workarounds when protocol adds proper support.
Don't let protocol gaps block ahpx progress.

---

## Cross-cutting concerns

These aren't tied to a single phase but should be addressed throughout v0.2:

- **Documentation:** Every new feature gets usage examples in the README and
  updated skill docs in `.github/skills/`.
- **Testing:** Every phase should maintain or improve the test-to-code ratio.
  New features need unit and integration tests.
- **TypeScript strictness:** Maintain full type safety. No `any` types. All
  public APIs have proper type declarations.
- **Backward compatibility:** CLI commands from v0.1 must continue to work.
  Library API is new and can be designed freely.
- **Performance:** WebSocket connections should be efficient. No unnecessary
  reconnections. Event processing should not block the main thread.

---

## Issue triage summary

All 24 open issues, mapped to v0.2 phases:

| Phase | Count | Issues |
|-------|-------|--------|
| 7: Library Mode | 2 | #7, #9 |
| 8: Multi-Session | 1 | #31 |
| 9: Event Forwarding | 1 | #8 |
| 10: Fleet Management | 2 | #28, #30 |
| 11: Robust Multi-Turn | 6 | #5, #6, #10, #25, #26, #29 |
| 12: Production Hardening | 12 | #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #27 |
| **Total** | **24** | |

---

## What's not in v0.2

To keep scope realistic, these are explicitly deferred:

- **GUI/TUI interface** — ahpx stays CLI + library. Dashboard UIs consume the
  event forwarding API.
- **Multi-language SDKs** — TypeScript/Node.js only. Other language SDKs are a
  separate project.
- **AHP server implementation** — ahpx is a client. Server-side work belongs
  to the AHP protocol repo.
- **Plugin system** — extensibility is valuable but premature. Design for it;
  don't build it yet.
