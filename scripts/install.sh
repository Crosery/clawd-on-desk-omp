#!/bin/sh
# Install/update the Clawd on Desk ↔ OMP bridge.
#
#   sh scripts/install.sh
#
# Copies the extension into OMP's extensions directory, backing up whatever was
# there, then prints the Clawd-side registration steps for this machine.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_file="$repo_dir/clawd-on-desk-omp.ts"
# Script-level override for a non-default OMP agent directory.
target_dir="${OMP_AGENT_DIR:-$HOME/.omp/agent}/extensions"
target_file="$target_dir/clawd-on-desk-omp.ts"

if [ ! -f "$source_file" ]; then
	echo "missing $source_file" >&2
	exit 1
fi

if [ -f "$target_file" ] && cmp -s "$source_file" "$target_file"; then
	echo "already installed: $target_file"
else
	mkdir -p "$target_dir"
	if [ -f "$target_file" ]; then
		backup="$target_file.bak-$(date +%Y%m%d%H%M%S)"
		cp "$target_file" "$backup"
		echo "backed up existing extension -> $backup"
	fi
	cp "$source_file" "$target_file"
	echo "installed: $target_file"
fi

echo
if command -v node >/dev/null 2>&1; then
	node "$repo_dir/scripts/agent-id.mjs" || true
else
	echo "node not found — run 'node scripts/agent-id.mjs' later to get the agent id"
fi
echo
echo "Clawd side (once per executable path):"
echo "  1. Open Clawd on Desk → 设置 → Agents → the custom/unrecognized tool section."
echo "  2. Add the omp executable path shown above; Clawd assigns the agent id."
echo "  3. Restart running OMP sessions so the extension loads."
