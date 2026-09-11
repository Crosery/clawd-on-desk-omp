#!/usr/bin/env node
/**
 * Clawd custom-application id helper.
 *
 *   node scripts/agent-id.mjs [executable-path]   derive the id Clawd would assign
 *   node scripts/agent-id.mjs --registered        list what Clawd already registered
 *
 * The derivation mirrors Clawd's own: slug from the executable stem, plus the
 * first 12 hex digits of sha256 over the registered path (lowercased on
 * Windows). Run this after registering OMP in Clawd to confirm the bridge will
 * POST an accepted `agent_id` — and to get a value for `CLAWD_OMP_AGENT_ID`
 * when the launch path cannot match the registered one.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

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

function applicationId(executablePath) {
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

function readPrefs() {
	try {
		return JSON.parse(readFileSync(prefsPath, "utf8"));
	} catch {
		return null;
	}
}

function registeredApplications() {
	const prefs = readPrefs();
	return Array.isArray(prefs?.customApplications) ? prefs.customApplications : [];
}

const args = process.argv.slice(2);

if (args.includes("--registered")) {
	const applications = registeredApplications();
	if (applications.length === 0) {
		console.log(`No custom applications registered in ${prefsPath}`);
		process.exit(1);
	}
	for (const entry of applications) {
		console.log(`${entry.id}\t${entry.name ?? ""}\t${entry.executablePath ?? ""}`);
	}
	process.exit(0);
}

const target = args.find((arg) => !arg.startsWith("-"));
const defaultCandidates = [
	process.env.CLAWD_OMP_EXECUTABLE,
	join(homedir(), ".bun", "bin", process.platform === "win32" ? "omp.exe" : "omp"),
	process.platform === "darwin" ? "/opt/homebrew/bin/omp" : undefined,
	"/usr/local/bin/omp",
	join(homedir(), ".local", "bin", "omp"),
].filter(Boolean);

const resolved = target ?? defaultCandidates.find((candidate) => existsSync(candidate));

if (!resolved) {
	console.error("No omp executable found. Pass a path: node scripts/agent-id.mjs /path/to/omp");
	process.exit(1);
}

const id = applicationId(resolved);
const registered = registeredApplications().find((entry) => entry.id === id);

console.log(`path        ${resolved}${existsSync(resolved) ? "" : "  (does not exist)"}`);
console.log(`agent_id    ${id}`);
console.log(`registered  ${registered ? "yes — Clawd accepts this id" : "no — register this path in Clawd (Settings → Agents → custom tool discovery)"}`);
