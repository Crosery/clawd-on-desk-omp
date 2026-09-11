/**
 * Bridge self-check. Runs without touching Clawd's session list: the event
 * mapping is exercised against a stubbed `fetch`, and the live check is a GET
 * on Clawd's read-only health route.
 *
 *   bun scripts/selftest.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import clawdOmpMonitor, { clawdApplicationId, resolveAgentId, serverPort } from "../clawd-on-desk-omp.ts";

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

// ── id derivation ───────────────────────────────────────────────────────────

const derived = clawdApplicationId(join(homedir(), ".bun", "bin", "omp"));
check("id shape", /^custom-omp-[a-f0-9]{12}$/.test(derived), derived);
check(
	"id is path-bound",
	clawdApplicationId("/tmp/omp") !== derived,
	`${derived} vs ${clawdApplicationId("/tmp/omp")}`,
);

const prefsPath =
	process.platform === "win32"
		? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "clawd-on-desk", "clawd-prefs.json")
		: process.platform === "darwin"
			? join(homedir(), "Library", "Application Support", "clawd-on-desk", "clawd-prefs.json")
			: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "clawd-on-desk", "clawd-prefs.json");

let registered: string | undefined;
try {
	const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as {
		customApplications?: Array<{ id?: string; executablePath?: string; processName?: string }>;
	};
	registered = prefs.customApplications?.find((entry) => {
		const stem = entry.executablePath ? basename(entry.executablePath, extname(entry.executablePath)).toLowerCase() : "";
		return entry.processName?.toLowerCase() === "omp" || stem === "omp";
	})?.id;
} catch {
	registered = undefined;
}

const resolved = resolveAgentId();
check("resolver returns an id", typeof resolved === "string" && resolved.length > 0, resolved ?? "undefined");
if (registered) {
	check("resolver prefers the registered id", resolved === registered, `registered=${registered} resolved=${resolved}`);
} else {
	console.log(`note no registered omp application in ${prefsPath} — register it in Clawd before relying on the bridge`);
}
check("port in Clawd's range", serverPort() >= 23333 && serverPort() <= 23337, String(serverPort()));

// ── event mapping (stubbed transport) ───────────────────────────────────────

type Sent = Record<string, unknown>;
const sent: Sent[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
	sent.push(JSON.parse(String(init?.body)) as Sent);
	return new Response(null, { status: 200 });
}) as typeof fetch;

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers: Record<string, Handler> = {};
const warnings: string[] = [];
clawdOmpMonitor({
	setLabel() {},
	logger: {
		warn: (message: string) => void warnings.push(message),
		info() {},
		debug() {},
		error() {},
	},
	on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
		handlers[name] = handler;
	},
} as unknown as Parameters<typeof clawdOmpMonitor>[0]);

const session = { id: "01a0-selftest", name: "bridge selftest" };
const ctx = {
	hasUI: true,
	cwd: "/tmp",
	sessionManager: {
		getSessionId: () => session.id,
		getSessionName: () => session.name,
	},
};

/** Drain the queued microtasks and the stubbed POST chain before asserting. */
async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	await promise;
}

async function fire(name: string, event: unknown = {}): Promise<void> {
	const handler = handlers[name];
	if (!handler) throw new Error(`extension did not register a handler for ${name}`);
	await handler(event, ctx);
	await settle();
}

await fire("session_start", { type: "session_start" });
await fire("before_agent_start", { type: "before_agent_start" });
await fire("tool_call", { type: "tool_call", toolName: "read", toolCallId: "t1" });
await fire("tool_result", { type: "tool_result", toolName: "read", toolCallId: "t1", isError: true });
await fire("session_stop", { type: "session_stop" });
await fire("session_shutdown", { type: "session_shutdown" });

const expected: Array<[string, string]> = [
	["SessionStart", "idle"],
	["UserPromptSubmit", "thinking"],
	["PreToolUse", "working"],
	["PostToolUseFailure", "error"],
	["Stop", "attention"],
	["SessionEnd", "sleeping"],
];
check("six lifecycle posts", sent.length === expected.length, `got ${sent.length}`);
expected.forEach(([event, state], index) => {
	const payload = sent[index] ?? {};
	check(
		`post ${index + 1} is ${event}/${state}`,
		payload.event === event && payload.state === state,
		JSON.stringify(payload),
	);
});
check(
	"payload carries the Clawd session key",
	sent[0]?.session_id === "omp:01a0-selftest" && sent[0]?.session_title === "OMP · bridge selftest",
	JSON.stringify(sent[0]),
);
check("tool identity is forwarded", sent[2]?.tool_name === "read" && sent[2]?.tool_use_id === "t1", JSON.stringify(sent[2]));

// Headless workers (subagents, background jobs) must stay invisible.
const before = sent.length;
await handlers.tool_call!({ toolName: "read", toolCallId: "t2" }, { ...ctx, hasUI: false });
await settle();
check("headless sessions are ignored", sent.length === before, `${sent.length - before} post(s)`);

// Switching sessions must retire the previous one instead of leaking a row.
session.id = "01a0-selftest-2";
await fire("session_start", { type: "session_start" });
const retreat = sent[sent.length - 2] ?? {};
check(
	"session switch retires the old session",
	retreat.session_id === "omp:01a0-selftest" && retreat.event === "SessionEnd" && retreat.state === "sleeping",
	JSON.stringify(retreat),
);

globalThis.fetch = realFetch;
check("no resolution warnings", warnings.length === 0, warnings.join("; "));

// ── live transport (read-only) ──────────────────────────────────────────────

try {
	const response = await fetch(`http://127.0.0.1:${serverPort()}/state`, { signal: AbortSignal.timeout(500) });
	const body = (await response.json()) as { ok?: boolean; app?: string };
	check("Clawd health endpoint", response.ok && body.app === "clawd-on-desk", JSON.stringify(body));
} catch {
	console.log(`note Clawd not reachable on 127.0.0.1:${serverPort()} — skipping the live transport check`);
}

const executable = join(homedir(), ".bun", "bin", "omp");
if (!existsSync(executable)) console.log(`note ${executable} does not exist on this machine`);

console.log(failures === 0 ? "self-check passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
