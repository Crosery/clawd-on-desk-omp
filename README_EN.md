<div align="center">

<img src="assets/logo.jpg" alt="clawd-on-desk-omp" width="320" />

# clawd-on-desk-omp

### Give the Clawd on your desktop a window into OMP

<p>Clawd on Desk ships adapters for 20+ CLI agents and not for OMP. This bridge fills the gap: pet state, session HUD, completion chime, and one-click jump back to the terminal.</p>

<p><b>中文简介：</b>clawd-on-desk-omp 通过 Clawd on Desk 的「自定义应用」通道把 OMP (oh-my-pi) 会话接进来——宠物状态、会话 HUD、完成提示音、跳回终端全部可用，两侧都不需要改一行代码。</p>

<p>
  <a href="README.md"><b>中文</b></a>
  &nbsp;|&nbsp;
  <a href="README_EN.md"><b>English</b></a>
</p>

<p>
  <a href="#quick-start"><b>Quick Start</b></a>
  &nbsp;·&nbsp;
  <a href="#event-mapping"><b>Event Mapping</b></a>
  &nbsp;·&nbsp;
  <a href="#what-it-solves"><b>What It Solves</b></a>
  &nbsp;·&nbsp;
  <a href="docs/protocol.md"><b>Protocol</b></a>
</p>

<sub>OMP extension + Clawd custom application · macOS / Linux / Windows · Zero modification to either side</sub>

</div>

---

<div align="center">

## Architecture

<img src="assets/architecture.jpg" alt="clawd-on-desk-omp architecture" width="100%" />

</div>

---

## In one sentence

Clawd on Desk is a closed-source Electron desktop pet that accepts agents it does not ship an adapter for through a public *custom application* channel: **register an executable path, then any local process that POSTs lifecycle state to its loopback endpoint gets session-level UI equal to a built-in agent.**

This repository is the OMP half of that contract. The adaptation has exactly two parts, and neither side is patched:

- **Clawd side (one-off, a few clicks)** — register the `omp` executable; Clawd assigns an agent id.
- **OMP side (one file)** — drop `clawd-on-desk-omp.ts` into `~/.omp/agent/extensions/`; it subscribes to OMP extension events and translates them into Clawd's state.

---

## What it solves

| Before | With clawd-on-desk-omp |
|---|---|
| A long OMP run finishes while you are elsewhere and nothing tells you | `session_stop` fires the completion chime and the pet celebration |
| Several OMP sessions open, no idea which one is waiting on you | Each interactive session gets its own row, labelled with its OMP session name and current tool |
| Getting back to a session means hunting through terminal tabs | `source_pid` + `pid_chain` are reported, so Clawd focuses the exact pane/tab |
| Clawd has adapters for everything except OMP | A registered custom application gets first-class treatment |
| A hand-rolled hook might slow the agent down or break a tool result | 250 ms timeout with every error swallowed — reporting never blocks OMP |
| Changing machines or install paths breaks the wiring | Three-step id resolution: env override → Clawd's registered entry → derived from known paths |

---

## Features

- **Zero intrusion** — no Clawd patch, one file in OMP; upgrading either side cannot be blocked by this bridge
- **Completion only from a settled turn** — `session_stop`, not `agent_end`, so background work never triggers a false "done"
- **Automatic agent-id resolution** — env override → the entry already registered in Clawd's prefs → derivation from known executable paths; nothing hardcoded
- **Headless stays silent** — subagents and background workers never appear in Clawd
- **Jump works** — ancestor pid chain resolves to Ghostty, cmux, iTerm2, Terminal, WezTerm, kitty or Warp
- **Failures are invisible** — a failed POST is swallowed, never surfaced into an OMP tool result
- **Self-checkable** — `scripts/selftest.ts` verifies the event mapping over a stubbed transport and writes nothing into Clawd

---

## Quick Start

### 1. Clone and install the extension

```bash
git clone https://github.com/Crosery/clawd-on-desk-omp.git
cd clawd-on-desk-omp
sh scripts/install.sh
```

`install.sh` does two things:
- copies the extension to `~/.omp/agent/extensions/clawd-on-desk-omp.ts` (backing up an existing file to `.bak.<timestamp>`)
- prints the derived agent id and what is still needed on the Clawd side

> Non-default OMP directory: `OMP_AGENT_DIR=/path/to/.omp/agent sh scripts/install.sh`

### 2. Register OMP inside Clawd

Clawd on Desk → **Settings → Agents → custom / unrecognized tool section** → pick the `omp` executable.

Clawd assigns an id of the form `custom-omp-<12 hex digits>` and stores it under `customApplications` in `clawd-prefs.json`.

**The id is bound to the exact path you registered** (a symlink and its target differ), so launch OMP from that path. Observed on the author's machine:

```
/Users/crosery/.bun/bin/omp   →   custom-omp-f83ec4ad2e8a
```

### 3. Verify

```bash
node scripts/agent-id.mjs          # prints the agent id and whether Clawd accepts it
bun scripts/selftest.ts            # event mapping + port discovery + Clawd health route (read-only)
curl -s http://127.0.0.1:23333/state   # {"ok":true,"app":"clawd-on-desk","port":23333}
```

Then **restart your OMP sessions** (the extension loads at session start) and `OMP · <session name>` shows up in Clawd.

If OMP is not launched from the registered path (wrapper script, `bun link`, Windows shim), pin the id:

```bash
export CLAWD_OMP_AGENT_ID=custom-omp-f83ec4ad2e8a
```

---

## Event Mapping

| OMP event | Clawd event | state | note |
| --- | --- | --- | --- |
| `session_start` / `session_switch` / `session_branch` | `SessionStart` | `idle` | session created or switched |
| `before_agent_start` | `UserPromptSubmit` | `thinking` | user submitted a prompt |
| `tool_call` | `PreToolUse` | `working` | tool started |
| `tool_result` | `PostToolUse` / `PostToolUseFailure` | `working` / `error` | failures get the error animation |
| `session_stop` | `Stop` | `attention` | the **only** completion signal: the turn settled |
| `session_before_compact` | `PreCompact` | `sweeping` | compaction in progress |
| `session_compact` | `PostCompact` | `attention` | compaction finished |
| `session_shutdown` | `SessionEnd` | `sleeping` | session ended, pet goes to sleep |

Two traps, both documented in the source:

- **Report completion from `session_stop`, never from `agent_end`.** `agent_end` also fires for scheduling pauses (background jobs still running, queued follow-ups), so using it makes Clawd announce completion while the session is still working. `session_stop` means the turn truly settled and never fires for subagent sessions.
- **Prefer OMP's own session name.** Interactive sessions frequently share one cwd; labelling them all `OMP · <dir>` makes Clawd's list — and its jump targets — indistinguishable.

States, events, accepted fields, port discovery and session-key encoding are fully described in [`docs/protocol.md`](docs/protocol.md), reverse-engineered from Clawd 1.0.0's observed behaviour.

---

## Limits

- **No approval bubble.** Custom applications are state-only in Clawd (`permissionsEnabled` is rejected); permission prompts remain a built-in-hook feature of agents like Claude Code, Codex and Kimi.
- **Jump needs a terminal.** Clawd resolves focus from the reported `source_pid` + `pid_chain`; sessions without a terminal ancestor pid are listed but not focusable.
- **The protocol is reverse-engineered.** Clawd on Desk is a closed-source third-party app; endpoints and fields can change between releases. This bridge fails by doing nothing, which never affects OMP itself.
- **Interactive sessions only.** `ctx.hasUI === false` headless workers are skipped entirely.

---

## Layout

```
clawd-on-desk-omp/
├── clawd-on-desk-omp.ts        the extension (install.sh copies it into ~/.omp/agent/extensions/)
├── scripts/
│   ├── install.sh              install / update the extension, backing up
│   ├── agent-id.mjs            derive and verify the Clawd-side agent id
│   ├── selftest.ts             end-to-end self-check: mapping + port + endpoint reachability
│   └── typecheck.sh            type-check against the locally installed OMP API
├── docs/protocol.md            the Clawd custom-application state protocol
└── assets/                     logo and architecture artwork used by this README
```

---

## Design Principles

1. **Reporting fails silently** — desktop monitoring is decoration; it must never slow down or alter an OMP tool result
2. **Completion comes only from a settled turn** — a loop-boundary event is not a completion event
3. **Only the public registration channel** — no Clawd patch, no dependency on an unregistered path, no guessed id
4. **One row per interactive session** — headless workers do not pollute Clawd's list
5. **Degrade gracefully on protocol drift** — unknown fields are ignored; a dead endpoint means nothing happens

---

## Credits

Clawd on Desk and OMP (oh-my-pi) are independent projects by their respective authors. This is not an official adapter; the protocol notes are observational and imply no affiliation with Clawd on Desk.

<div align="center">
<sub>MIT · so the little crab knows what OMP is up to</sub>
</div>
