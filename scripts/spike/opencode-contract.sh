#!/usr/bin/env bash
# OpenCode adapter contract spike (yuurei issue #106).
#
# Runs OpenCode entirely against throwaway HOME/XDG/TMPDIR roots under $TMPDIR,
# and against decoy "real home" roots that simulate an operator's global config.
# It never points HOME or XDG_*/TMPDIR at the operator's real directories, so it
# is safe to rerun at any time. No secret values are printed; only file names,
# paths, structure, exit codes, and event keys.
#
# Usage:
#   OPENCODE_BIN=/path/to/opencode scripts/spike/opencode-contract.sh
#   SPIKE_WITH_AUTH=1 OPENCODE_BIN=... scripts/spike/opencode-contract.sh
#
# To obtain a specific version for the floor check:
#   R=$(mktemp -d); curl -fsSL -o "$R/oc.zip" \
#     https://github.com/anomalyco/opencode/releases/download/v1.18.0/opencode-darwin-arm64.zip
#   unzip -q "$R/oc.zip" -d "$R"; OPENCODE_BIN="$R/opencode" scripts/spike/opencode-contract.sh
set -uo pipefail

OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
SPIKE_WITH_AUTH="${SPIKE_WITH_AUTH:-0}"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/yuurei-opencode-spike-XXXXXX")"
CELL_HOME="$ROOT/home"
XDG_CONFIG="$ROOT/xdg/config"
XDG_DATA="$ROOT/xdg/data"
XDG_STATE="$ROOT/xdg/state"
XDG_CACHE="$ROOT/xdg/cache"
CELL_TMP="$ROOT/tmp"
WORK="$ROOT/work"
mkdir -p "$CELL_HOME" "$XDG_CONFIG" "$XDG_DATA" "$XDG_STATE" "$XDG_CACHE" "$CELL_TMP" "$WORK"

# Decoy "real home" simulates the operator's global config so a read surfaces
# as a sentinel that must never appear in isolated output.
REAL_HOME="$ROOT/decoy-real-home"
mkdir -p "$REAL_HOME/.config/opencode" "$REAL_HOME/.claude/skills/claudesentinel" \
  "$REAL_HOME/.agents/skills/agentsentinel" "$REAL_HOME/.codex" \
  "$REAL_HOME/.local/share/opencode" "$REAL_HOME/.local/state/opencode"
printf '{"$schema":"https://opencode.ai/config.json","username":"SENTINEL_REAL_GLOBAL_CONFIG"}\n' \
  >"$REAL_HOME/.config/opencode/opencode.json"
printf -- '---\nname: claudesentinel\ndescription: SENTINEL_CLAUDE_SKILL use when testing.\n---\n\n# sentinel\n' \
  >"$REAL_HOME/.claude/skills/claudesentinel/SKILL.md"
printf -- '---\nname: agentsentinel\ndescription: SENTINEL_AGENTS_SKILL use when testing.\n---\n\n# sentinel\n' \
  >"$REAL_HOME/.agents/skills/agentsentinel/SKILL.md"
printf '{"openrouter":{"type":"api","key":"SENTINEL_AUTH_KEY"}}\n' \
  >"$REAL_HOME/.local/share/opencode/auth.json"

# The env a level0/level1 adapter is expected to impose. TMPDIR matters: without
# it OpenCode resolves `tmp` to /tmp/opencode, outside the cell.
iso_env=(
  "PATH=$PATH"
  "HOME=$CELL_HOME"
  "XDG_CONFIG_HOME=$XDG_CONFIG"
  "XDG_DATA_HOME=$XDG_DATA"
  "XDG_STATE_HOME=$XDG_STATE"
  "XDG_CACHE_HOME=$XDG_CACHE"
  "TMPDIR=$CELL_TMP"
  "OPENCODE_DISABLE_AUTOUPDATE=1"
  "OPENCODE_DISABLE_PROJECT_CONFIG=1"
  "OPENCODE_DISABLE_EXTERNAL_SKILLS=1"
)

section() { printf '\n===== %s =====\n' "$1"; }

section "inventory"
printf 'opencode_bin: %s\n' "$OPENCODE_BIN"
printf 'version: '
"$OPENCODE_BIN" --version 2>&1 || printf '(failed)\n'
printf 'root: %s\n' "$ROOT"

section "debug paths (isolated HOME+XDG+TMPDIR) - all roots must be inside the cell"
env -i "${iso_env[@]}" "$OPENCODE_BIN" debug paths 2>&1

section "debug paths (HOME only, no XDG/TMPDIR) - documents the level0 bypass if unset"
env -i "PATH=$PATH" "HOME=$REAL_HOME" "OPENCODE_DISABLE_AUTOUPDATE=1" "$OPENCODE_BIN" debug paths 2>&1

section "global config read (isolated vs HOME-only)"
iso_cfg="$(env -i "${iso_env[@]}" "$OPENCODE_BIN" debug config 2>&1)"
printf 'isolated reads decoy global config: %s\n' "$(printf '%s' "$iso_cfg" | grep -c SENTINEL_REAL_GLOBAL_CONFIG)"
home_cfg="$(env -i "PATH=$PATH" "HOME=$REAL_HOME" "OPENCODE_DISABLE_AUTOUPDATE=1" "$OPENCODE_BIN" debug config 2>&1)"
printf 'HOME-only reads decoy global config: %s\n' "$(printf '%s' "$home_cfg" | grep -c SENTINEL_REAL_GLOBAL_CONFIG)"

section "project config from cwd"
printf '{"$schema":"https://opencode.ai/config.json","username":"SENTINEL_PROJECT_CONFIG"}\n' >"$WORK/opencode.json"
( cd "$WORK" && env -i "${iso_env[@]}" OPENCODE_DISABLE_PROJECT_CONFIG=0 "$OPENCODE_BIN" debug config 2>&1 ) \
  | grep -c SENTINEL_PROJECT_CONFIG | sed 's/^/project config read without the flag: /'
( cd "$WORK" && env -i "${iso_env[@]}" "$OPENCODE_BIN" debug config 2>&1 ) \
  | grep -c SENTINEL_PROJECT_CONFIG | sed 's/^/project config read with the flag: /'

section "external skill import (~/.claude, ~/.agents)"
env -i "PATH=$PATH" "HOME=$REAL_HOME" "XDG_CONFIG_HOME=$XDG_CONFIG" "XDG_DATA_HOME=$XDG_DATA" \
  "XDG_STATE_HOME=$XDG_STATE" "XDG_CACHE_HOME=$XDG_CACHE" "TMPDIR=$CELL_TMP" "$OPENCODE_BIN" debug skill 2>&1 \
  | grep -c SENTINEL | sed 's/^/no disables, sentinel hits: /'
env -i "${iso_env[@]}" "$OPENCODE_BIN" debug skill 2>&1 \
  | grep -c SENTINEL | sed 's/^/DISABLE_EXTERNAL_SKILLS=1, sentinel hits: /'

section "{file:...} reach outside the cell (HOME=decoy)"
mkdir -p "$XDG_CONFIG/opencode"
printf '{"$schema":"https://opencode.ai/config.json","provider":{"openrouter":{"options":{"apiKey":"{file:~/.local/share/opencode/auth.json}"}}}}\n' \
  >"$XDG_CONFIG/opencode/opencode.json"
env -i "PATH=$PATH" "HOME=$REAL_HOME" "XDG_CONFIG_HOME=$XDG_CONFIG" "XDG_DATA_HOME=$XDG_DATA" \
  "XDG_STATE_HOME=$XDG_STATE" "XDG_CACHE_HOME=$XDG_CACHE" "TMPDIR=$CELL_TMP" "$OPENCODE_BIN" debug config 2>&1 \
  | grep -c SENTINEL_AUTH_KEY | sed 's/^/{file:~...auth.json} resolved decoy credential: /'
rm -f "$XDG_CONFIG/opencode/opencode.json"

section "authless run (isolated)"
( cd "$WORK" && env -i "${iso_env[@]}" "$OPENCODE_BIN" run --format json --auto "reply with the single word ok" \
  >"$ROOT/run.out" 2>"$ROOT/run.err" </dev/null )
printf 'exit_code: %s\n' "$?"
python3 - "$ROOT/run.out" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        print("<malformed>"); continue
    p = o.get("part") if isinstance(o.get("part"), dict) else {}
    t = p.get("tokens") if isinstance(p.get("tokens"), dict) else None
    print(o.get("type"), "| part.type=", p.get("type"),
          "| token_keys=", sorted(t.keys()) if t else None,
          "| cache_keys=", sorted(t.get("cache", {}).keys()) if t and isinstance(t.get("cache"), dict) else None,
          "| has_cost=", "cost" in p)
PY

section "forced auth-required model without credentials"
( cd "$WORK" && env -i "${iso_env[@]}" "$OPENCODE_BIN" run --format json --auto \
  -m "openrouter/anthropic/claude-3.5-haiku" "reply ok" >"$ROOT/fail.out" 2>"$ROOT/fail.err" </dev/null )
printf 'exit_code: %s\n' "$?"
printf 'event_types: '
python3 - "$ROOT/fail.out" <<'PY'
import json, sys
out = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: out.append(json.loads(line).get("type"))
    except Exception: out.append("<malformed>")
print(out)
PY
printf 'stderr_bytes: %s\n' "$(wc -c <"$ROOT/fail.err" | tr -d ' ')"

if [ "$SPIKE_WITH_AUTH" = "1" ]; then
  section "authed run (isolated + network)"
  auth_env=()
  for name in OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY ${SPIKE_AUTH_VARS:-}; do
    [ -n "${!name:-}" ] && auth_env+=("$name=${!name}")
  done
  ( cd "$WORK" && env -i "${iso_env[@]}" "${auth_env[@]}" "$OPENCODE_BIN" run --format json --auto \
    "reply with the single word ok" >"$ROOT/authed.out" 2>"$ROOT/authed.err" </dev/null )
  printf 'exit_code: %s\n' "$?"
  printf 'isolated auth.json created: %s\n' "$([ -f "$XDG_DATA/opencode/auth.json" ] && echo yes || echo no)"
  head -c 800 "$ROOT/authed.out"
else
  printf '\n(skipped authed run; set SPIKE_WITH_AUTH=1 with credentials)\n'
fi

section "cleanup"
rm -rf "$ROOT"
printf 'removed %s\n' "$ROOT"
