# Type-check the extension against the OMP extension API.
#
#   sh scripts/typecheck.sh
#
# OMP is installed as a bun global package, so its type declarations are not on
# this repo's module path. Link them in, then run tsc — no dependencies are
# added to the repo itself.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

omp_bin=$(command -v omp || true)
if [ -z "$omp_bin" ]; then
	echo "omp not found on PATH; set OMP_BIN=/path/to/omp" >&2
	exit 1
fi
omp_bin=${OMP_BIN:-$omp_bin}

# .../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js -> .../node_modules
resolved=$(readlink -f "$omp_bin" 2>/dev/null || echo "$omp_bin")
node_modules_dir=$(CDPATH= cd -- "$(dirname -- "$resolved")/../../.." && pwd)

if [ ! -d "$node_modules_dir/@oh-my-pi/pi-coding-agent" ]; then
	echo "cannot locate @oh-my-pi/pi-coding-agent from $omp_bin (looked in $node_modules_dir)" >&2
	exit 1
fi

if [ ! -e "$repo_dir/node_modules" ]; then
	ln -s "$node_modules_dir" "$repo_dir/node_modules"
	echo "linked $repo_dir/node_modules -> $node_modules_dir"
fi

cd "$repo_dir"
if command -v bunx >/dev/null 2>&1; then
	exec bunx tsc -p tsconfig.json
fi
exec npx --yes typescript@latest tsc -p tsconfig.json
