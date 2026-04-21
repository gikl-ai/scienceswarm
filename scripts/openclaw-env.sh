# openclaw-env.sh — source this to set OpenClaw env vars according to
# ScienceSwarm's mode-split contract. Mirrors src/lib/openclaw/runner.ts
# exactly. Changes to the resolution logic MUST update both files.
# A parity test at tests/lib/openclaw-runner-shell-parity.test.ts
# guarantees the two resolvers cannot drift out of sync.
#
# Usage:
#   source scripts/openclaw-env.sh
#   openclaw_resolve_env || exit 1
#   openclaw_build_argv gateway run --port 18789 --bind loopback
#   openclaw "${OPENCLAW_ARGV[@]}"
#
# Mode split:
#   - OPENCLAW_PROFILE set and non-empty  → profile mode (upstream --profile)
#   - otherwise                            → state-dir mode under $SCIENCESWARM_DIR/openclaw

openclaw_profile_pid_slug() {
  local profile="$1"
  local safe_profile=""
  local profile_hex=""

  # Match runner.ts exactly: ASCII-only keep set for readability plus a
  # hex suffix of the original profile so distinct inputs never collide.
  safe_profile="$(printf '%s' "$profile" | perl -CSDA -pe 's/[^A-Za-z0-9._-]/_/g')"
  profile_hex="$(printf '%s' "$profile" | od -An -tx1 -v | tr -d ' \n')"
  printf '%s-%s\n' "$safe_profile" "$profile_hex"
}

openclaw_gateway_pid_file() {
  local data_root="${SCIENCESWARM_DIR:-$HOME/.scienceswarm}"

  if [ -n "${OPENCLAW_PROFILE:-}" ] && [[ "${OPENCLAW_PROFILE}" =~ [^[:space:]] ]]; then
    printf '%s\n' "${TMPDIR:-/tmp}/openclaw-gateway-$(openclaw_profile_pid_slug "$OPENCLAW_PROFILE").pid"
  else
    printf '%s\n' "$data_root/openclaw/gateway.pid"
  fi
}

openclaw_ensure_state_dir() {
  local state_dir="$1"
  local tmp_dir

  if [ -L "$state_dir" ]; then
    if [ ! -d "$state_dir" ]; then
      echo "openclaw-env: legacy symlink at $state_dir does not point to a directory" >&2
      return 1
    fi

    tmp_dir="${state_dir}.migrate-${PPID:-$$}-$$"
    rm -rf "$tmp_dir" 2>/dev/null || true
    if ! mkdir -p "$tmp_dir" 2>/dev/null; then
      echo "openclaw-env: cannot create migration dir for $state_dir" >&2
      return 1
    fi
    if ! cp -Rp "$state_dir"/. "$tmp_dir"/ 2>/dev/null; then
      rm -rf "$tmp_dir" 2>/dev/null || true
      echo "openclaw-env: failed to copy legacy symlinked OpenClaw state from $state_dir" >&2
      return 1
    fi
    if ! rm "$state_dir" 2>/dev/null; then
      rm -rf "$tmp_dir" 2>/dev/null || true
      echo "openclaw-env: failed to unlink legacy OpenClaw symlink at $state_dir" >&2
      return 1
    fi
    if ! mv "$tmp_dir" "$state_dir" 2>/dev/null; then
      rm -rf "$tmp_dir" 2>/dev/null || true
      echo "openclaw-env: failed to replace legacy OpenClaw symlink at $state_dir" >&2
      return 1
    fi
    return 0
  fi

  if [ -e "$state_dir" ] && [ ! -d "$state_dir" ]; then
    echo "openclaw-env: $state_dir exists but is not a directory" >&2
    return 1
  fi

  if ! mkdir -p "$state_dir" 2>/dev/null; then
    echo "openclaw-env: cannot create $state_dir (permission denied or read-only filesystem)" >&2
    return 1
  fi
}

openclaw_resolve_env() {
  local data_root="${SCIENCESWARM_DIR:-$HOME/.scienceswarm}"
  # Match the TS resolver's `.trim().length > 0` check: whitespace-only
  # OPENCLAW_PROFILE is treated as unset (state-dir mode, not profile mode).
  if [ -n "${OPENCLAW_PROFILE:-}" ] && [[ "${OPENCLAW_PROFILE}" =~ [^[:space:]] ]]; then
    # Profile mode: upstream owns paths; clear any state-dir overrides so
    # a stale shell export doesn't shadow the profile's state.
    unset OPENCLAW_STATE_DIR
    unset OPENCLAW_CONFIG_PATH
    export SCIENCESWARM_OPENCLAW_MODE="profile"
  else
    # State-dir mode: app-owned state under $SCIENCESWARM_DIR/openclaw.
    export OPENCLAW_STATE_DIR="$data_root/openclaw"
    export OPENCLAW_CONFIG_PATH="$data_root/openclaw/openclaw.json"
    if ! openclaw_ensure_state_dir "$OPENCLAW_STATE_DIR"; then
      return 1
    fi
    export SCIENCESWARM_OPENCLAW_MODE="state-dir"
  fi
}

# openclaw_build_argv <openclaw-subcommand> [args...]
#   → sets OPENCLAW_ARGV=(--profile <name> <subcommand> [args...]) in profile mode
#   → sets OPENCLAW_ARGV=(<subcommand> [args...]) in state-dir mode
openclaw_build_argv() {
  # Match the TS resolver's `.trim().length > 0` check: whitespace-only
  # OPENCLAW_PROFILE is treated as unset (state-dir mode, not profile mode).
  if [ -n "${OPENCLAW_PROFILE:-}" ] && [[ "${OPENCLAW_PROFILE}" =~ [^[:space:]] ]]; then
    OPENCLAW_ARGV=(--profile "$OPENCLAW_PROFILE" "$@")
  else
    OPENCLAW_ARGV=("$@")
  fi
}
