/**
 * Clawd on Desk — custom application state protocol (as used by this bridge).
 *
 * Reverse-engineered from Clawd on Desk 1.0.0 by observing its HTTP server and
 * its shipped hook/plugin clients. Clawd is a third-party, closed-source app:
 * treat this as an interface description that can change between releases, and
 * keep the bridge's failure mode "silently do nothing".
 */

# Transport

- Server binds `127.0.0.1` only. No authentication; any local process can post.
- Port: first free port in `23333..23337`. The winner is announced in
  `~/.clawd/runtime.json`:
  `{"app":"clawd-on-desk","port":23333,"ownerPid":20812,...}`.
  Read it before every POST so a restarted app on a different port still works;
  fall back to the first port when the file is missing (Clawd closed).
- `GET /state` → health: `{"ok":true,"app":"clawd-on-desk","port":23333}`.
  Use it to verify wiring without creating anything.
- `POST /state` → lifecycle. Body: JSON, max 16 KiB (larger → `413`, and the
  sender sees the failure only as a failed request — nothing is retried).
- `POST /permission` exists for agents with hook-based permission prompts;
  custom applications are state-only and are not part of that flow.

# Registration (the "custom application")

A custom application is an executable registered in Clawd's settings, persisted
in `clawd-prefs.json` (`app.getPath("userData")`, e.g. on macOS
`~/Library/Application Support/clawd-on-desk/clawd-prefs.json`):

```json
{
  "customApplications": [
    { "id": "custom-omp-f83ec4ad2e8a", "name": "OMP",
      "sourcePath": "~/.bun/bin/omp", "executablePath": "~/.bun/bin/omp",
      "processName": "omp", "category": "code" }
  ],
  "agents": { "custom-omp-f83ec4ad2e8a": { "enabled": true, "notificationHookEnabled": true } }
}
```

- `id` = `custom-<slug>-<sha256(executablePath)[0..12]>`. `<slug>` comes from the
  executable stem with non-alphanumerics folded to `-`; the hash is over the
  registered path (lowercased on Windows), so a symlink and its target are
  different applications. `scripts/agent-id.mjs` prints it.
- `POST /state` with a `custom-*` `agent_id` that is **not** in
  `customApplications` is dropped with `204` — no session, no error.
- A disabled agent (`agents[id].enabled === false`) is also dropped with `204`.
- Custom applications are *state-only*: Clawd refuses `permissionsEnabled` for
  them ("custom state-only agents"), so there is no approval bubble, no hook
  auto-install, and no quota/statusline integration. Approval routing stays with
  the agents Clawd ships hooks for.

# Session identity and namespacing

- `session_id` is free-form per application. Before use, Clawd prefixes custom
  sessions with `<agent_id>:` unless already prefixed, so two custom apps that
  both send `"default"` cannot collide.
- Internally the id becomes a versioned envelope
  `s1.<base64url(profileId)>.<base64url(rawId)>` with `profileId = "local"` for
  local sessions (SSH/remote profiles use their own id). This is why a Clawd
  session key looks like `custom-omp-f83ec4ad2e8a:omp:01a08e16-…`.
- No `session_id` → `"default"`, i.e. a single stable pseudo-session per app.
- Sessions are keyed by that id: switching ids mid-stream leaves the old entry
  behind unless the sender ends it explicitly. This bridge retires the previous
  session with `event: "SessionEnd", state: "sleeping"` when the id changes.

# Accepted body fields

Only a handful are required; unknown keys are ignored, malformed values silently
fall back to defaults.

| field | meaning |
| --- | --- |
| `agent_id` | required; the `custom-*` id, else the POST is dropped |
| `hook_source` | free-form provenance label (this bridge sends `omp-extension`) |
| `session_id` | session identity, see above |
| `session_title` | dashboard label; ignored when empty |
| `state` | see the state table |
| `event` | lifecycle event name; drives the completion/approval heuristics |
| `cwd` | working directory shown on the row |
| `source_pid` | pid of the terminal host process — **required for "jump to terminal"** |
| `pid_chain` | ancestor pids for the same resolution (ascending) |
| `editor` | `"code"` / `"cursor"` to focus an IDE window instead of a terminal |
| `agent_pid` | pid of the agent process itself |
| `tool_name`, `tool_use_id` | current tool, for the dashboard row and dedupe |
| `headless` | `true` hides the session from the HUD and from jump targets |
| `assistant_last_output` | text for the completion bubble (≤2400 chars, byte-capped) |
| `metadata_only` | annotate an existing session (quota/context) and never create one |
| `preserve_state` | keep the current visual state instead of switching |
| `context_usage`, `*_quota` | context/quota telemetry, mostly for shipped agents |
| `platform`, `model`, `provider`, `host`, `wsl_distro` | provenance shown in the UI |
| `ghostty_terminal_id`, `tmux_socket`, `tmux_client`, `orca_pane_key` | extra focus hints for those terminals |

# States

`state` selects the animation/summary layer. Priority decides which session wins
when several are live.

| state | priority | meaning |
| --- | --- | --- |
| `error` | 8 | tool call or turn failed |
| `notification` | 7 | needs the user (permission prompts, agent notices) |
| `sweeping` | 6 | housekeeping/compaction — one-shot, auto-returns |
| `attention` | 5 | done / wants attention — one-shot, plays the completion sound |
| `carrying`, `juggling` | 4 | background work, subagents |
| `working` | 3 | running tools |
| `thinking` | 2 | prompt submitted, no tool yet |
| `idle` | 1 | awaiting input |
| `sleeping` | 0 | session ended/closed |

One-shot states (auto-return to the session's real state): `attention`, `error`,
`sweeping`, `notification`, `carrying`. Sleep sequence states (`yawning`,
`dozing`, `collapsing`, `sleeping`, `waking`) belong to the pet, not the wire.

# Events

Free-form, but only two names are special:

- `Stop` — or `event_msg:task_complete` — marks a completed turn: Clawd plays
  the completion sound, flags the session "done", and treats it as done for the
  duplicate-completion guards. Any other name is bookkeeping: it still updates
  recency and clears stale-session timers.
- `SessionEnd` — paired with `state: "sleeping"` this retires the entry.
  Forward-progress events (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `SessionEnd`, …) cancel a pending debounced completion.

Practical consequence: report "done" from a *settled* turn only. A loop-boundary
event that also fires for scheduling pauses (OMP's `agent_end`) produces a false
completion, because Clawd cannot tell it apart from a real stop.

# Focus / jump to terminal

Clawd focuses a session by walking `pid_chain` from `source_pid` to a known
terminal (Ghostty, cmux, iTerm2, Terminal, WezTerm, kitty, Warp, …) and then
selecting the right pane/tab — Ghostty and cmux use their own session stores,
which is why the full ancestor chain matters. A session without `source_pid` is
listed but not focusable, and sessions marked `headless` are hidden from the HUD.
There is no OMP-specific focus path: jump works only through the terminal that
launched `omp`.
