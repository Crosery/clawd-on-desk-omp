# clawd-on-desk-omp

Make [Clawd on Desk](https://clawd-on-desk) see and drive **OMP** (oh-my-pi) sessions: desktop-pet state, the session HUD, the completion chime, and "jump back to the terminal".

Clawd on Desk ships first-class integrations for Claude Code, Codex, Gemini CLI, Pi, Hermes and more — but not for OMP. It does expose a *custom application* channel: register an executable by path, then any local process that POSTs lifecycle state to Clawd's loopback endpoint gets session-level UI equal to a built-in agent. This repository is the OMP side of that contract.

## How the adaptation works

Nothing inside Clawd is modified; there are exactly two halves.

1. **Clawd side — register a custom application (one-off, manual).**
   Settings → Agents → custom/unrecognized tool section → pick the omp executable.
   Clawd assigns `custom-<slug>-<sha256(path)[0..12]>` and stores it under `customApplications` in `clawd-prefs.json`.
   Observed on this machine: `/Users/crosery/.bun/bin/omp` → `custom-omp-f83ec4ad2e8a`, and Clawd session keys look like `custom-omp-f83ec4ad2e8a:omp:<session-uuid>`.
   The id is bound to **the path you registered** (a symlink and its target differ); re-register when the path changes.

2. **OMP side — one extension (this repo).**
   Drop `clawd-on-desk-omp.ts` into `~/.omp/agent/extensions/`. It subscribes to OMP extension events, translates each into Clawd's `state` + `event`, and POSTs them locally.
   Headless workers (subagents, background jobs) stay silent; each interactive session owns exactly one row in Clawd.

| OMP event | Clawd event | state | note |
| --- | --- | --- | --- |
| `session_start` / `session_switch` / `session_branch` | `SessionStart` | `idle` | session created or switched |
| `before_agent_start` | `UserPromptSubmit` | `thinking` | user submitted a prompt |
| `tool_call` | `PreToolUse` | `working` | tool started |
| `tool_result` | `PostToolUse` / `PostToolUseFailure` | `working` / `error` | failures get the error animation |
| `session_stop` | `Stop` | `attention` | the **only** completion signal: the turn settled |
| `session_before_compact` | `PreCompact` | `sweeping` | compaction in progress |
| `session_compact` | `PostCompact` | `attention` | compaction finished |
| `session_shutdown` | `SessionEnd` | `sleeping` | session ended |

Two traps worth stating:

- **Report completion from `session_stop`, never from `agent_end`.** `agent_end` also fires for scheduling pauses (background jobs still running, queued follow-ups), so using it makes Clawd announce completion while the session is still working.
- **Prefer OMP's own session name.** Interactive sessions frequently share one cwd; labelling them all `OMP · <dir>` makes Clawd's list — and its jump targets — indistinguishable.

## Install

```sh
git clone <this repo> && cd clawd-on-desk-omp
sh scripts/install.sh          # copies the extension, prints the agent id
node scripts/agent-id.mjs      # confirm the id Clawd accepts
```

Then register the omp executable in Clawd's settings (above) and restart OMP sessions. If OMP is not launched from the registered path (wrapper script, `bun link`, Windows shim), pin the id explicitly:

```sh
export CLAWD_OMP_AGENT_ID=custom-omp-f83ec4ad2e8a
```

Self-check:

```sh
bun scripts/selftest.ts        # id derivation, port discovery, health endpoint (read-only)
curl -s http://127.0.0.1:23333/state   # {"ok":true,"app":"clawd-on-desk","port":23333}
```

## Limits

- **No approval bubble.** Custom applications are state-only in Clawd (`permissionsEnabled` is rejected); permission prompts remain a built-in-hook feature of agents like Claude Code and Codex.
- **Jump needs a terminal.** Clawd resolves focus from the reported `source_pid` + `pid_chain` to a known terminal (Ghostty, cmux, iTerm2, Terminal, WezTerm, kitty, Warp …) and then selects the pane/tab. Sessions without a terminal ancestor pid are listed but not focusable.
- **Reporting failures stay silent.** 250 ms timeout, every error swallowed: desktop monitoring must never block or alter an OMP tool result.
- **The protocol is reverse-engineered.** Clawd on Desk is a closed-source third-party app; endpoints and fields can change between releases. This bridge fails by doing nothing, which never affects OMP itself.

## Layout

```
clawd-on-desk-omp.ts     the extension (copied into ~/.omp/agent/extensions/)
scripts/install.sh       install/update the extension
scripts/agent-id.mjs     derive and verify the Clawd-side agent id
scripts/selftest.ts      end-to-end self-check (id, port, endpoint reachability)
scripts/typecheck.sh     type-check against the locally installed OMP API
docs/protocol.md         the Clawd custom-application state protocol
```

## License

MIT. Not an official Clawd on Desk project; the protocol notes are observational and imply no affiliation.
