/**
 * Clawd on Desk ↔ OMP bridge.
 *
 * Clawd on Desk ships first-class integrations for a long list of CLI agents
 * (Claude Code, Codex, Gemini CLI, Pi, …) but not for OMP. It does accept
 * *custom applications*: an executable the user registers by path, plus any
 * local process that POSTs lifecycle state to Clawd's loopback endpoint
 * (`127.0.0.1:<port>/state`). This extension is the OMP side of that contract —
 * it maps OMP extension events onto Clawd's session model so the desktop pet,
 * the session HUD and "jump to terminal" all work against OMP sessions.
 *
 * Install: copy this file into `~/.omp/agent/extensions/`, register the OMP
 * executable in Clawd's settings (自定义 / unrecognized tool discovery), then
 * restart OMP. See README.md; `scripts/agent-id.mjs` prints the exact id Clawd
 * derives for a given executable path.
 *
 * Wire protocol: docs/protocol.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

type State = "idle" | "thinking" | "working" | "attention" | "error" | "sweeping" | "sleeping";

type TerminalMetadata = {
	source_pid?: number;
	pid_chain: number[];
	editor?: "code" | "cursor";
};

type Payload = TerminalMetadata & {
	agent_id: string;
	hook_source: "omp-extension";
	session_id: string;
	session_title: string;
	agent_pid: number;
	cwd: string;
	event: string;
	state: State;
	tool_name?: string;
	tool_use_id?: string;
};

type ClawdPreferences = {
	customApplications?: Array<{ id?: string; name?: string; executablePath?: string; processName?: string }>;
};

const runtimePath = join(homedir(), ".clawd", "runtime.json");

// Electron's app.getPath("userData") for the "clawd-on-desk" app — where Clawd
// persists `customApplications`, the registration this bridge depends on.
const prefsPath = (() => {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
		return join(appData, "clawd-on-desk", "clawd-prefs.json");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "clawd-on-desk", "clawd-prefs.json");
	}
	const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(configHome, "clawd-on-desk", "clawd-prefs.json");
})();

const executableCandidates: Array<string | undefined> = [
	process.env.CLAWD_OMP_EXECUTABLE,
	join(homedir(), ".bun", "bin", process.platform === "win32" ? "omp.exe" : "omp"),
	process.platform === "darwin" ? "/opt/homebrew/bin/omp" : undefined,
	"/usr/local/bin/omp",
	join(homedir(), ".local", "bin", "omp"),
];

const terminalNames: Record<string, true> = {
	terminal: true,
	iterm2: true,
	ghostty: true,
	cmux: true,
	alacritty: true,
	"wezterm-gui": true,
	kitty: true,
	hyper: true,
	tabby: true,
	warp: true,
	superset: true,
	orca: true,
};

/**
 * Clawd's `applicationId()`: `custom-<slug>-<sha256(executablePath)[0..12]>`,
 * where `<slug>` comes from the executable stem (`-`/`_` folded to spaces), not
 * from the display name a user may edit afterwards. The hash covers the path as
 * registered — a symlink and its target yield different ids, so register the
 * exact path you launch.
 */
export function clawdApplicationId(executablePath: string): string {
	const stem = basename(executablePath, extname(executablePath))
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const key = process.platform === "win32" ? executablePath.toLowerCase() : executablePath;
	const slug = (stem || "Custom application")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32) || "app";
	return `custom-${slug}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** Id of the OMP application already registered in Clawd's preferences. */
function registeredOmpApplicationId(): string | undefined {
	let prefs: ClawdPreferences;
	try {
		prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as ClawdPreferences;
	} catch {
		return undefined;
	}
	const entries = Array.isArray(prefs.customApplications) ? prefs.customApplications : [];
	for (const entry of entries) {
		if (!entry || typeof entry.id !== "string" || !entry.id.startsWith("custom-")) continue;
		const executable = typeof entry.executablePath === "string" ? entry.executablePath : "";
		const processName = typeof entry.processName === "string" ? entry.processName : "";
		const stem = executable ? basename(executable, extname(executable)).toLowerCase() : "";
		if (processName.toLowerCase() === "omp" || stem === "omp") return entry.id;
	}
	return undefined;
}

/**
 * Resolve the agent id Clawd accepts:
 *   1. `CLAWD_OMP_AGENT_ID` — explicit override for launchers whose registered
 *      path is unusual (wrappers, `bun link`, Windows shims).
 *   2. The `omp` entry already registered in Clawd's preferences — the normal
 *      path, and immune to which of several omp installs is first on PATH.
 *   3. The first known omp executable that exists, hashed the way Clawd would.
 * Unresolved means "not registered in Clawd": the bridge stays silent instead of
 * POSTing an id the server rejects.
 */
export function resolveAgentId(): string | undefined {
	const override = process.env.CLAWD_OMP_AGENT_ID?.trim();
	if (override) return override;
	const registered = registeredOmpApplicationId();
	if (registered) return registered;
	const candidate = executableCandidates.find((path): path is string => typeof path === "string" && existsSync(path));
	return candidate ? clawdApplicationId(candidate) : undefined;
}

function resolveTerminalMetadata(): TerminalMetadata {
	const metadata: TerminalMetadata = { pid_chain: [] };
	let pid = process.pid;
	for (let depth = 0; depth < 12 && pid > 1 && !metadata.pid_chain.includes(pid); depth++) {
		let row: string;
		try {
			row = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 500,
				maxBuffer: 8192,
			}).trim();
		} catch {
			break;
		}
		const match = row.match(/^(\d+)\s+(.+)$/);
		if (!match) break;
		metadata.pid_chain.push(pid);
		const command = (match[2] ?? "").toLowerCase();
		const name = basename(command);
		const editor = name === "code" || command.includes("visual studio code.app/")
			? "code"
			: name === "cursor" || command.includes("cursor.app/") ? "cursor" : undefined;
		if (Object.hasOwn(terminalNames, name) || editor) {
			metadata.source_pid = pid;
			if (editor) metadata.editor = editor;
			break;
		}
		pid = Number(match[1]);
	}
	return metadata;
}

/**
 * Clawd binds the first free port in a small fixed range and announces the
 * winner in `~/.clawd/runtime.json`; the range guard keeps a stale or mangled
 * file from aiming POSTs at an unrelated local service.
 */
export function serverPort(): number {
	try {
		const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as { port?: number };
		if (Number.isInteger(runtime.port) && (runtime.port as number) >= 23333 && (runtime.port as number) <= 23337) {
			return runtime.port as number;
		}
	} catch {
		// Clawd may be closed; its default port is safe to probe locally.
	}
	return 23333;
}

async function postState(payload: Payload): Promise<void> {
	try {
		const response = await fetch(`http://127.0.0.1:${serverPort()}/state`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(250),
			redirect: "error",
		});
		await response.body?.cancel();
	} catch {
		// Optional desktop monitoring must never block or change OMP tool results.
	}
}

export default function clawdOmpMonitor(omp: ExtensionAPI): void {
	omp.setLabel("Clawd on Desk · OMP");
	let delivery = Promise.resolve();
	let current: Payload | undefined;
	let terminalMetadata: TerminalMetadata | undefined;
	let resolvedAgentId: string | undefined;
	let resolutionFailed = false;

	function report(
		state: State,
		event: string,
		ctx: ExtensionContext,
		tool?: { toolName: string; toolCallId: string },
	): Promise<void> {
		// Ignore headless workers; each interactive OMP session owns its own entry.
		if (!ctx.hasUI) return Promise.resolve();
		if (!resolvedAgentId) {
			resolvedAgentId = resolveAgentId();
			if (!resolvedAgentId) {
				if (!resolutionFailed) {
					resolutionFailed = true;
					omp.logger.warn("Clawd on Desk: no OMP custom application registered — state reporting disabled", {
						prefsPath,
					});
				}
				return Promise.resolve();
			}
		}
		terminalMetadata ??= resolveTerminalMetadata();
		// Prefer OMP's own session title (auto-generated or user-set); several
		// interactive sessions legitimately share one cwd, and an identical
		// "OMP · <dir>" label per session makes Clawd's list (and its jump
		// targets) impossible to tell apart.
		const named = ctx.sessionManager.getSessionName()?.trim();
		const payload: Payload = {
			agent_id: resolvedAgentId,
			hook_source: "omp-extension",
			session_id: `omp:${ctx.sessionManager.getSessionId()}`,
			session_title: named ? `OMP · ${named}` : `OMP · ${basename(ctx.cwd)}`,
			agent_pid: process.pid,
			...terminalMetadata,
			cwd: ctx.cwd,
			event,
			state,
			...(tool ? { tool_name: tool.toolName, tool_use_id: tool.toolCallId } : {}),
		};
		if (current && current.session_id !== payload.session_id) {
			const previous: Payload = { ...current, event: "SessionEnd", state: "sleeping" };
			delivery = delivery.then(() => postState(previous));
		}
		current = event === "SessionEnd" ? undefined : payload;
		delivery = delivery.then(() => postState(payload));
		return delivery;
	}

	omp.on("session_start", (_event, ctx) => report("idle", "SessionStart", ctx));
	omp.on("session_switch", (_event, ctx) => report("idle", "SessionStart", ctx));
	omp.on("session_branch", (_event, ctx) => report("idle", "SessionStart", ctx));
	omp.on("before_agent_start", (_event, ctx) => report("thinking", "UserPromptSubmit", ctx));
	omp.on("tool_call", (event, ctx) => report("working", "PreToolUse", ctx, event));
	omp.on("tool_result", (event, ctx) => report(
		event.isError ? "error" : "working",
		event.isError ? "PostToolUseFailure" : "PostToolUse",
		ctx,
		event,
	));
	// agent_end is only a loop-boundary notification: OMP fires it for scheduling
	// pauses as well — background jobs still running, queued follow-ups, settles
	// that left tool calls in flight — so reporting "完成" from it made Clawd
	// announce completion while the session kept working. session_stop is the
	// settled turn: it never fires for task/subagent sessions and it defers until
	// agent-owned background jobs are idle. Not returning the promise keeps the
	// harness from waiting on our local POST before the turn settles.
	omp.on("session_stop", (_event, ctx) => {
		void report("attention", "Stop", ctx);
	});
	omp.on("session_before_compact", (_event, ctx) => report("sweeping", "PreCompact", ctx));
	omp.on("session_compact", (_event, ctx) => report("attention", "PostCompact", ctx));
	omp.on("session_shutdown", (_event, ctx) => report("sleeping", "SessionEnd", ctx));
}
