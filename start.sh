#!/bin/bash
set -e

is_wsl() {
  [ -n "${WSL_INTEROP:-}" ] || [ -n "${WSL_DISTRO_NAME:-}" ] || \
    grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null
}

is_mounted_windows_path() {
  case "${1:-}" in
    /mnt/[A-Za-z]|/mnt/[A-Za-z]/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

warn_wsl_path() {
  local label="$1"
  local path_value="$2"
  if ! is_wsl || [ -z "$path_value" ] || ! is_mounted_windows_path "$path_value"; then
    return 0
  fi
  echo "WARNING: WSL detected and $label is on a mounted Windows drive:"
  echo "  $path_value"
  echo "  ScienceSwarm is faster when the repo and data live in the WSL Linux filesystem"
  echo "  (for example ~/scienceswarm and ~/.scienceswarm) instead of /mnt/c/..."
}

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

pid_is_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

launcher_pid_matches() {
  local pid="$1"
  local command=""

  command=$(ps -o command= -p "$pid" 2>/dev/null || true)
  case "$command" in
    *start.sh*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

read_launcher_pid() {
  local raw
  if [ ! -f "$LAUNCHER_PID_FILE" ]; then
    return 1
  fi
  raw=$(tr -d '[:space:]' < "$LAUNCHER_PID_FILE" 2>/dev/null || true)
  if ! [[ "$raw" =~ ^[0-9]+$ ]] || [ "$raw" -le 0 ]; then
    rm -f "$LAUNCHER_PID_FILE"
    return 1
  fi
  if ! pid_is_running "$raw"; then
    rm -f "$LAUNCHER_PID_FILE"
    return 1
  fi
  if ! launcher_pid_matches "$raw"; then
    rm -f "$LAUNCHER_PID_FILE"
    return 1
  fi
  printf '%s\n' "$raw"
}

write_launcher_pid() {
  mkdir -p "$RUN_ROOT"
  printf '%s\n' "$$" > "$LAUNCHER_PID_FILE"
}

clear_launcher_pid() {
  local recorded_pid=""
  [ -n "${LAUNCHER_PID_FILE:-}" ] || return 0
  [ -f "$LAUNCHER_PID_FILE" ] || return 0
  recorded_pid=$(tr -d '[:space:]' < "$LAUNCHER_PID_FILE" 2>/dev/null || true)
  [ "$recorded_pid" = "$$" ] || return 0
  rm -f "$LAUNCHER_PID_FILE"
}

write_openhands_container_id() {
  local container_id="$1"
  [ -n "${OPENHANDS_CONTAINER_FILE:-}" ] || return 0
  mkdir -p "$RUN_ROOT"
  printf '%s\n' "$container_id" > "$OPENHANDS_CONTAINER_FILE"
}

clear_openhands_container_id() {
  [ -n "${OPENHANDS_CONTAINER_FILE:-}" ] || return 0
  rm -f "$OPENHANDS_CONTAINER_FILE"
}

write_openclaw_gateway_pid() {
  local pid="$1"
  [ -n "${OPENCLAW_GATEWAY_PID_FILE:-}" ] || return 0
  mkdir -p "$(dirname "$OPENCLAW_GATEWAY_PID_FILE")"
  printf '%s\n' "$pid" > "$OPENCLAW_GATEWAY_PID_FILE"
}

BACKGROUND_PIDS=()
cleanup_background_loops() {
  for pid in "${BACKGROUND_PIDS[@]}"; do
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
}

cleanup_start_runtime() {
  clear_launcher_pid
  cleanup_background_loops
}

trap cleanup_start_runtime EXIT INT TERM

echo "🔬 ScienceSwarm — Starting..."
echo ""

# Capture inherited shell overrides BEFORE sourcing `.env` so we can
# tell the operator which values came from the shell session rather
# than the repo-local config file.
INHERITED_SCIENCESWARM_DIR_SET=false
INHERITED_BRAIN_ROOT_SET=false
INHERITED_FRONTEND_PORT_SET=false
INHERITED_FRONTEND_HOST_SET=false
INHERITED_FRONTEND_PUBLIC_HOST_SET=false
INHERITED_FRONTEND_USE_HTTPS_SET=false
INHERITED_OPENCLAW_PORT_SET=false
INHERITED_OPENCLAW_STATE_DIR_SET=false
INHERITED_OPENCLAW_CONFIG_PATH_SET=false
INHERITED_SCIENCESWARM_OPENCLAW_MODE_SET=false
if [ "${SCIENCESWARM_DIR+x}" = "x" ]; then INHERITED_SCIENCESWARM_DIR_SET=true; fi
if [ "${BRAIN_ROOT+x}" = "x" ]; then INHERITED_BRAIN_ROOT_SET=true; fi
if [ "${FRONTEND_PORT+x}" = "x" ]; then INHERITED_FRONTEND_PORT_SET=true; fi
if [ "${FRONTEND_HOST+x}" = "x" ]; then INHERITED_FRONTEND_HOST_SET=true; fi
if [ "${FRONTEND_PUBLIC_HOST+x}" = "x" ]; then INHERITED_FRONTEND_PUBLIC_HOST_SET=true; fi
if [ "${FRONTEND_USE_HTTPS+x}" = "x" ]; then INHERITED_FRONTEND_USE_HTTPS_SET=true; fi
if [ "${OPENCLAW_PORT+x}" = "x" ]; then INHERITED_OPENCLAW_PORT_SET=true; fi
if [ "${OPENCLAW_STATE_DIR+x}" = "x" ]; then INHERITED_OPENCLAW_STATE_DIR_SET=true; fi
if [ "${OPENCLAW_CONFIG_PATH+x}" = "x" ]; then INHERITED_OPENCLAW_CONFIG_PATH_SET=true; fi
if [ "${SCIENCESWARM_OPENCLAW_MODE+x}" = "x" ]; then INHERITED_SCIENCESWARM_OPENCLAW_MODE_SET=true; fi

# Load env. Export while sourcing so child processes like
# `scripts/print-port.ts` can see repo-local overrides such as
# OPENHANDS_PORT / OPENCLAW_PORT from `.env`, not just values the
# operator exported manually in their shell.
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Source the OpenClaw shell resolver (mirrors src/lib/openclaw/runner.ts) and
# resolve OpenClaw env vars NOW — before any openclaw invocation below. The
# resolver aborts start.sh if the state dir cannot be created, because we
# can't start a gateway against an uncreatable state dir.
# shellcheck source=scripts/openclaw-env.sh
source scripts/openclaw-env.sh
if ! openclaw_resolve_env; then
  echo "error: failed to resolve OpenClaw environment (see above)" >&2
  exit 1
fi

# Hydrate port env vars from scripts/print-port.ts (graceful if tsx not yet installed)
if command -v npx &>/dev/null && [ -f scripts/print-port.ts ]; then
  eval "$(npx tsx scripts/print-port.ts env 2>/dev/null || true)"
fi
: "${FRONTEND_PORT:=3001}"
: "${FRONTEND_HOST:=127.0.0.1}"
: "${FRONTEND_PUBLIC_HOST:=$FRONTEND_HOST}"
: "${FRONTEND_USE_HTTPS:=true}"
: "${OPENHANDS_PORT:=3000}"
: "${OPENHANDS_IMAGE:=docker.openhands.dev/openhands/openhands@sha256:5c0dc26f467bf8e47a6e76308edb7a30af4084b17e23a3460b5467008b12111b}"
export FRONTEND_HOST FRONTEND_PUBLIC_HOST OPENHANDS_IMAGE

DATA_ROOT="${SCIENCESWARM_DIR:-$HOME/.scienceswarm}"
RUN_ROOT="$DATA_ROOT/run"
LAUNCHER_PID_FILE="$RUN_ROOT/launcher.pid"
OPENHANDS_CONTAINER_FILE="$RUN_ROOT/openhands.cid"
OPENCLAW_GATEWAY_PID_FILE="$(openclaw_gateway_pid_file)"

ensure_frontend_https_cert() {
  local key_path="$1"
  local cert_path="$2"
  local openssl_config=""

  if [ -f "$key_path" ] && [ -f "$cert_path" ]; then
    return 0
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    return 1
  fi

  mkdir -p "$(dirname "$key_path")" "$(dirname "$cert_path")"
  openssl_config="$(mktemp)"
  cat > "$openssl_config" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = localhost

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF

  if openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -keyout "$key_path" \
    -out "$cert_path" \
    -config "$openssl_config" >/dev/null 2>&1; then
    rm -f "$openssl_config"
    return 0
  fi

  rm -f "$openssl_config"
  return 1
}

FRONTEND_SCHEME="http"
NEXT_FRONTEND_ARGS=()

if is_truthy "${FRONTEND_USE_HTTPS}"; then
  FRONTEND_SCHEME="https"
  NEXT_FRONTEND_ARGS+=(--experimental-https)

  if [ -z "${FRONTEND_HTTPS_KEY:-}" ] && [ -z "${FRONTEND_HTTPS_CERT:-}" ]; then
    FRONTEND_HTTPS_KEY="$DATA_ROOT/certificates/localhost-key.pem"
    FRONTEND_HTTPS_CERT="$DATA_ROOT/certificates/localhost.pem"
  fi

  if [ -n "${FRONTEND_HTTPS_KEY:-}" ] && [ -n "${FRONTEND_HTTPS_CERT:-}" ]; then
    if ! ensure_frontend_https_cert "$FRONTEND_HTTPS_KEY" "$FRONTEND_HTTPS_CERT"; then
      echo "error: FRONTEND_USE_HTTPS is enabled, but no certificate/key pair is available." >&2
      echo "  Expected key:  $FRONTEND_HTTPS_KEY" >&2
      echo "  Expected cert: $FRONTEND_HTTPS_CERT" >&2
      echo "  Install openssl, provide FRONTEND_HTTPS_KEY and FRONTEND_HTTPS_CERT, or set FRONTEND_USE_HTTPS=false." >&2
      exit 1
    fi
    NEXT_FRONTEND_ARGS+=(--experimental-https-key "${FRONTEND_HTTPS_KEY}" --experimental-https-cert "${FRONTEND_HTTPS_CERT}")
    export FRONTEND_HTTPS_KEY FRONTEND_HTTPS_CERT
  else
    echo "error: FRONTEND_USE_HTTPS is enabled but only one of FRONTEND_HTTPS_KEY/FRONTEND_HTTPS_CERT is set." >&2
    echo "  Provide both values or unset both so ScienceSwarm can use $DATA_ROOT/certificates." >&2
    exit 1
  fi
fi

NEXT_FRONTEND_ARGS+=(--webpack -H "${FRONTEND_HOST}" -p "${FRONTEND_PORT}")

if [ -z "${APP_ORIGIN:-}" ] && [ "${FRONTEND_SCHEME}" = "https" ]; then
  APP_ORIGIN="${FRONTEND_SCHEME}://${FRONTEND_PUBLIC_HOST}:${FRONTEND_PORT}"
  export APP_ORIGIN
fi

is_placeholder_value() {
  case "${1:-}" in
    ""|"sk-your-key-here"|"replace-me")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_openhands_local_model() {
  local model="${OLLAMA_MODEL:-gemma4:latest}"
  model="${model#openai/}"
  model="${model#ollama/}"
  printf 'openai/%s' "$model"
}

warn_wsl_path "repo root" "$PWD"
warn_wsl_path "SCIENCESWARM_DIR" "$DATA_ROOT"
warn_wsl_path "BRAIN_ROOT" "${BRAIN_ROOT:-}"

EXISTING_LAUNCHER_PID="$(read_launcher_pid || true)"
if [ -n "$EXISTING_LAUNCHER_PID" ] && [ "$EXISTING_LAUNCHER_PID" != "$$" ]; then
  echo "ScienceSwarm is already running for $DATA_ROOT (launcher pid $EXISTING_LAUNCHER_PID)."
  echo "Use ./scienceswarm status, ./scienceswarm stop, or ./scienceswarm restart."
  exit 1
fi
write_launcher_pid

echo "Resolved runtime:"
echo "  ScienceSwarm data root: $DATA_ROOT"
[ -n "${LAUNCHER_PID_FILE:-}" ] && echo "  Launcher pid file: $LAUNCHER_PID_FILE"
[ -n "${BRAIN_ROOT:-}" ] && echo "  Brain root override: $BRAIN_ROOT"
echo "  Frontend host: $FRONTEND_HOST"
echo "  Frontend scheme: $FRONTEND_SCHEME"
[ "$FRONTEND_PUBLIC_HOST" != "$FRONTEND_HOST" ] && echo "  Frontend public host: $FRONTEND_PUBLIC_HOST"
echo "  Frontend port: $FRONTEND_PORT"
echo "  Frontend origin: ${APP_ORIGIN:-${FRONTEND_SCHEME}://${FRONTEND_HOST}:${FRONTEND_PORT}}"
echo "  OpenClaw port: ${OPENCLAW_PORT:-18789}"
[ -n "${OPENCLAW_STATE_DIR:-}" ] && echo "  OpenClaw state dir: $OPENCLAW_STATE_DIR"
[ -n "${OPENCLAW_CONFIG_PATH:-}" ] && echo "  OpenClaw config path: $OPENCLAW_CONFIG_PATH"
[ -n "${SCIENCESWARM_OPENCLAW_MODE:-}" ] && echo "  OpenClaw mode: $SCIENCESWARM_OPENCLAW_MODE"
[ "$INHERITED_SCIENCESWARM_DIR_SET" = true ] && echo "  Note: SCIENCESWARM_DIR came from the shell environment."
[ "$INHERITED_BRAIN_ROOT_SET" = true ] && echo "  Note: BRAIN_ROOT came from the shell environment."
[ "$INHERITED_FRONTEND_PORT_SET" = true ] && echo "  Note: FRONTEND_PORT came from the shell environment."
[ "$INHERITED_FRONTEND_HOST_SET" = true ] && echo "  Note: FRONTEND_HOST came from the shell environment."
[ "$INHERITED_FRONTEND_PUBLIC_HOST_SET" = true ] && echo "  Note: FRONTEND_PUBLIC_HOST came from the shell environment."
[ "$INHERITED_FRONTEND_USE_HTTPS_SET" = true ] && echo "  Note: FRONTEND_USE_HTTPS came from the shell environment."
[ "$INHERITED_OPENCLAW_PORT_SET" = true ] && echo "  Note: OPENCLAW_PORT came from the shell environment."
[ "$INHERITED_OPENCLAW_STATE_DIR_SET" = true ] && echo "  Note: OPENCLAW_STATE_DIR came from the shell environment."
[ "$INHERITED_OPENCLAW_CONFIG_PATH_SET" = true ] && echo "  Note: OPENCLAW_CONFIG_PATH came from the shell environment."
[ "$INHERITED_SCIENCESWARM_OPENCLAW_MODE_SET" = true ] && echo "  Note: SCIENCESWARM_OPENCLAW_MODE came from the shell environment."
if [ "$INHERITED_SCIENCESWARM_DIR_SET" = true ] || \
   [ "$INHERITED_BRAIN_ROOT_SET" = true ] || \
   [ "$INHERITED_FRONTEND_PORT_SET" = true ] || \
   [ "$INHERITED_FRONTEND_HOST_SET" = true ] || \
   [ "$INHERITED_FRONTEND_PUBLIC_HOST_SET" = true ] || \
   [ "$INHERITED_FRONTEND_USE_HTTPS_SET" = true ] || \
   [ "$INHERITED_OPENCLAW_PORT_SET" = true ] || \
   [ "$INHERITED_OPENCLAW_STATE_DIR_SET" = true ] || \
   [ "$INHERITED_OPENCLAW_CONFIG_PATH_SET" = true ] || \
   [ "$INHERITED_SCIENCESWARM_OPENCLAW_MODE_SET" = true ]; then
  echo "WARNING: inherited runtime overrides are active."
  echo "  start.sh only sources .env; exported shell vars stay live unless .env replaces them."
  echo "  If this was accidental, rerun from a clean shell or use:"
  echo "  env -u SCIENCESWARM_DIR -u BRAIN_ROOT -u FRONTEND_PORT -u FRONTEND_HOST -u FRONTEND_PUBLIC_HOST -u FRONTEND_USE_HTTPS -u OPENCLAW_PORT -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH -u SCIENCESWARM_OPENCLAW_MODE ./start.sh"
fi
case "$FRONTEND_PUBLIC_HOST" in
  127.*|localhost|::1)
    ;;
  *)
    echo "WARNING: FRONTEND_PUBLIC_HOST is not loopback. Local-only setup/settings routes will refuse writes unless a trusted proxy supplies loopback client headers."
    ;;
esac
echo ""

# Ensure the configured local data root exists. The OpenClaw state dir is
# already created by openclaw_resolve_env above (default mode). The
# OpenHands state dir is created just before the docker run below so
# the Docker bind mount doesn't auto-create a root-owned dir on the host.
mkdir -p "$DATA_ROOT/projects"

# Check if setup was run
if [ ! -f node_modules/.package-lock.json ]; then
  echo "First time? Run ./install.sh first."
  exit 1
fi

# Detect available services
DOCKER_OK=false
OPENCLAW_OK=false
API_KEY_OK=false

command -v docker &>/dev/null && docker info &>/dev/null 2>&1 && DOCKER_OK=true
command -v openclaw &>/dev/null && OPENCLAW_OK=true
if ! is_placeholder_value "$OPENAI_API_KEY"; then
  API_KEY_OK=true
fi

# Detect agent
if command -v openclaw &>/dev/null; then
  AGENT="openclaw"
elif [ -d "nanoclaw" ] || [ -d "$HOME/scienceswarm/nanoclaw" ]; then
  AGENT="nanoclaw"
else
  AGENT="none"
fi

echo "Services detected:"
[ "$DOCKER_OK" = true ] && echo "  ✓ Docker" || echo "  ○ Docker (not available)"
[ "$OPENCLAW_OK" = true ] && echo "  ✓ OpenClaw" || echo "  ○ OpenClaw (not installed)"
[ "$API_KEY_OK" = true ] && echo "  ✓ OpenAI API key (optional cloud fallback)" || echo "  ○ OpenAI API key (optional cloud fallback, not configured)"
echo "  Agent: $AGENT"
echo ""

if [ "$API_KEY_OK" = false ]; then
  echo "No OPENAI_API_KEY in .env. That's fine for the default local path."
  echo "  ScienceSwarm setup uses Ollama + gemma4:latest first."
  echo "  OpenHands cloud-backed agent start is deferred until you configure an API-backed model."
  echo "  Open ${FRONTEND_SCHEME}://127.0.0.1:${FRONTEND_PORT}/setup to connect OpenClaw and Telegram."
  echo ""
fi

# Start OpenHands when Docker is available and either:
# - local execution is configured via LLM_PROVIDER=local, or
# - a real OpenAI key is configured for cloud-backed execution.
if [ "$DOCKER_OK" = true ] && { [ "${LLM_PROVIDER:-}" = "local" ] || [ "$API_KEY_OK" = true ]; }; then
  # OpenHands 1.6 reads AGENT_SERVER_IMAGE_REPOSITORY + AGENT_SERVER_IMAGE_TAG
  # to resolve the sandbox image; the old SANDBOX_BASE_CONTAINER_IMAGE env var
  # no longer applies. If AGENT_SERVER_IMAGE_REPOSITORY is unset, OH falls
  # back to its stock ghcr.io/openhands/agent-server image.
  # Build the custom audit-revise image with ./scripts/build-sandbox.sh,
  # then set both vars in .env to opt in.
  #
  # OH_AGENT_SERVER_ENV passes arbitrary env to every sandbox action via JSON.
  _OH_HOST_URL="${SCIENCESWARM_HOST_URL:-http://host.docker.internal:${FRONTEND_PORT}}"
  _OH_SANDBOX_TOKEN="${SCIENCESWARM_SANDBOX_TOKEN:-}"
  # Ensure the OpenHands state dir exists with the current user's
  # ownership BEFORE docker runs. If we skip this, Docker auto-creates
  # the bind-mount source as a root-owned empty dir, which defeats the
  # "one ScienceSwarm-owned dotdir" goal of the env-var pivot.
  mkdir -p "$DATA_ROOT/openhands"
  # We used to print a "legacy ~/.openhands detected" notice here,
  # but it fired on EVERY launch for any user who had ever touched
  # a personal ~/.openhands (e.g. from standalone OpenHands use),
  # even though that directory is not ours and does not need
  # migration. Removed because it was noisy and not actionable.
  docker rm -f scienceswarm-agent >/dev/null 2>&1 || true
  clear_openhands_container_id

  if [ "${LLM_PROVIDER:-}" = "local" ]; then
    echo "Starting OpenHands agent in local mode..."
    _OH_LLM_MODEL="$(resolve_openhands_local_model)"
    _OH_LLM_BASE_URL="${LLM_BASE_URL:-http://host.docker.internal:11434/v1}"
    _OH_LLM_API_KEY="${LLM_API_KEY:-ollama-local}"
    _OH_OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-32768}"
    OPENHANDS_CONTAINER_ID="$(
      docker run -d --rm \
      -e LLM_PROVIDER=local \
      -e LLM_MODEL="$_OH_LLM_MODEL" \
      -e LLM_BASE_URL="$_OH_LLM_BASE_URL" \
      -e LLM_API_KEY="$_OH_LLM_API_KEY" \
      -e OLLAMA_CONTEXT_LENGTH="$_OH_OLLAMA_CONTEXT_LENGTH" \
      -e AGENT_SERVER_IMAGE_REPOSITORY="${AGENT_SERVER_IMAGE_REPOSITORY:-}" \
      -e AGENT_SERVER_IMAGE_TAG="${AGENT_SERVER_IMAGE_TAG:-}" \
      -e "OH_AGENT_SERVER_ENV={\"SCIENCESWARM_HOST_URL\":\"${_OH_HOST_URL}\",\"SCIENCESWARM_SANDBOX_TOKEN\":\"${_OH_SANDBOX_TOKEN}\"}" \
      -e MAX_ITERATIONS=100 \
      -e LOG_ALL_EVENTS=true \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$DATA_ROOT/openhands":/.openhands \
      -p "127.0.0.1:${OPENHANDS_PORT}:3000" \
      --add-host host.docker.internal:host-gateway \
      --name scienceswarm-agent \
      "$OPENHANDS_IMAGE" 2>/dev/null
    )" || true
    if [ -n "${OPENHANDS_CONTAINER_ID:-}" ]; then
      write_openhands_container_id "$OPENHANDS_CONTAINER_ID"
    else
      echo "  ⚠ OpenHands failed to start (port ${OPENHANDS_PORT} in use?)"
    fi
  else
    echo "Starting OpenHands agent..."
    OPENHANDS_CONTAINER_ID="$(
      docker run -d --rm \
      -e LLM_PROVIDER=openai \
      -e LLM_MODEL="${LLM_MODEL:-gpt-5.4}" \
      -e LLM_API_KEY="$OPENAI_API_KEY" \
      -e AGENT_SERVER_IMAGE_REPOSITORY="${AGENT_SERVER_IMAGE_REPOSITORY:-}" \
      -e AGENT_SERVER_IMAGE_TAG="${AGENT_SERVER_IMAGE_TAG:-}" \
      -e "OH_AGENT_SERVER_ENV={\"SCIENCESWARM_HOST_URL\":\"${_OH_HOST_URL}\",\"SCIENCESWARM_SANDBOX_TOKEN\":\"${_OH_SANDBOX_TOKEN}\"}" \
      -e MAX_ITERATIONS=100 \
      -e LOG_ALL_EVENTS=true \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$DATA_ROOT/openhands":/.openhands \
      -p "127.0.0.1:${OPENHANDS_PORT}:3000" \
      --add-host host.docker.internal:host-gateway \
      --name scienceswarm-agent \
      "$OPENHANDS_IMAGE" 2>/dev/null
    )" || true
    if [ -n "${OPENHANDS_CONTAINER_ID:-}" ]; then
      write_openhands_container_id "$OPENHANDS_CONTAINER_ID"
    else
      echo "  ⚠ OpenHands failed to start (port ${OPENHANDS_PORT} in use?)"
    fi
  fi

  # Wait for OpenHands
  echo -n "  Waiting for agent"
  for i in $(seq 1 15); do
    if curl -s -o /dev/null "http://localhost:${OPENHANDS_PORT}" 2>/dev/null; then
      echo " ✓"
      break
    fi
    echo -n "."
    sleep 2
  done
fi

# Check OpenClaw
# NOTE: env vars for OpenClaw (OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH /
# SCIENCESWARM_OPENCLAW_MODE) were already set by openclaw_resolve_env at
# the top of this script, so every openclaw invocation below inherits
# them. Argv is built via openclaw_build_argv so profile mode gets a
# --profile flag while state-dir mode does not.
if [ "$OPENCLAW_OK" = true ]; then
  openclaw_build_argv health
  if openclaw "${OPENCLAW_ARGV[@]}" >/dev/null 2>&1; then
    echo "  ✓ OpenClaw gateway already running"
  else
    echo "  Starting OpenClaw gateway..."
    openclaw_build_argv gateway run --port "${OPENCLAW_PORT:-18789}" --bind loopback
    nohup openclaw "${OPENCLAW_ARGV[@]}" > /dev/null 2>&1 &
    gateway_pid=$!
    disown
    write_openclaw_gateway_pid "$gateway_pid"
  fi
fi

# Optional: research-radar skill runner (Phase C / decision 1A).
# Gated OFF by default so existing dev/test flows do not accidentally
# spawn a background loop. Set ENABLE_RADAR_RUNNER=true to opt in.
# The runner is a separate node process by design — a crash in it
# must not be able to take down the dashboard. See
# .openclaw/skills/research-radar/SKILL.md for the playbook.
if [ "${ENABLE_RADAR_RUNNER:-false}" = "true" ]; then
  RADAR_INTERVAL_MIN="${SCIENCESWARM_RADAR_INTERVAL_MINUTES:-30}"
  # Guard against non-integer interval values. `$((RADAR_INTERVAL_MIN * 60))`
  # below is a bash arithmetic expansion; a non-integer (e.g. "2.5", "30m")
  # would raise an "arithmetic syntax error" inside the background subshell
  # and `set -e` would silently kill the loop after the first iteration. Fail
  # loudly with a default instead so the operator sees the problem.
  if ! [[ "$RADAR_INTERVAL_MIN" =~ ^[0-9]+$ ]] || [ "$RADAR_INTERVAL_MIN" -lt 1 ]; then
    echo "  ⚠ SCIENCESWARM_RADAR_INTERVAL_MINUTES must be a positive integer (got '${RADAR_INTERVAL_MIN}'); defaulting to 30."
    RADAR_INTERVAL_MIN=30
  fi
  echo ""
  echo "Starting research-radar skill runner (every ${RADAR_INTERVAL_MIN}m, separate process)..."
  # `set -m` inside the subshell puts it (and any `npx tsx` child it
  # spawns) into a fresh process group, so the trap below can signal the
  # whole group via `kill -- -PGID`. Without this, an in-flight
  # `npx tsx` child would be reparented to PID 1 on dev-server restart
  # and race the next loop on `.radar-last-run.json` + LLM calls.
  (
    set -m
    while true; do
      npx tsx scripts/run-research-radar.ts || \
        echo "  ⚠ research-radar exited non-zero — see stderr above; will retry on next interval."
      sleep $((RADAR_INTERVAL_MIN * 60))
    done
  ) &
  RADAR_PID=$!
  BACKGROUND_PIDS+=("$RADAR_PID")
  echo "  ✓ research-radar background loop pid=${RADAR_PID}"
fi

# Optional: dream-cycle runner. Enabled by default. The script itself
# reads the persisted dream schedule and exits cleanly when the run is
# not due, so we only need a bounded idle poll between scheduled windows.
if [ "${ENABLE_DREAM_RUNNER:-true}" = "true" ]; then
  DREAM_INTERVAL_MIN="${SCIENCESWARM_DREAM_CHECK_INTERVAL_MINUTES:-60}"
  if ! [[ "$DREAM_INTERVAL_MIN" =~ ^[0-9]+$ ]] || [ "$DREAM_INTERVAL_MIN" -lt 1 ]; then
    echo "  ⚠ SCIENCESWARM_DREAM_CHECK_INTERVAL_MINUTES must be a positive integer (got '${DREAM_INTERVAL_MIN}'); defaulting to 60."
    DREAM_INTERVAL_MIN=60
  fi
  DREAM_BRAIN_ROOT="${BRAIN_ROOT:-$DATA_ROOT/brain}"
  if [ -f "$DREAM_BRAIN_ROOT/BRAIN.md" ]; then
    echo ""
    echo "Starting dream-cycle runner (scheduled overnight; max idle poll ${DREAM_INTERVAL_MIN}m, separate process)..."
    (
      set -m
      while true; do
        npx tsx scripts/run-dream-cycle.ts || \
          echo "  ⚠ dream-cycle exited non-zero — see stderr above; will retry after the next scheduled wake-up."
        DREAM_SLEEP_SECONDS="$(
          npx tsx scripts/print-dream-runner-sleep.ts --max-minutes "$DREAM_INTERVAL_MIN" 2>/dev/null \
            || printf '%s\n' "$((DREAM_INTERVAL_MIN * 60))"
        )"
        if ! [[ "$DREAM_SLEEP_SECONDS" =~ ^[0-9]+$ ]] || [ "$DREAM_SLEEP_SECONDS" -lt 60 ]; then
          DREAM_SLEEP_SECONDS="$((DREAM_INTERVAL_MIN * 60))"
        fi
        sleep "$DREAM_SLEEP_SECONDS"
      done
    ) &
    DREAM_PID=$!
    BACKGROUND_PIDS+=("$DREAM_PID")
    echo "  ✓ dream-cycle background loop pid=${DREAM_PID}"
  else
    echo ""
    echo "Skipping dream-cycle runner until a brain is initialized at $DREAM_BRAIN_ROOT."
  fi
fi

# Start frontend
echo ""
echo "Starting ScienceSwarm frontend..."
echo ""

# Note: we intentionally do NOT `exec` next-dev here when background loops
# are enabled, so the EXIT trap above can clean up their process groups.
# The cost is one extra shell process in the tree; the benefit is no
# orphaned radar loops on dev-server restart.
OPENHANDS_URL="http://localhost:${OPENHANDS_PORT}" npx next dev "${NEXT_FRONTEND_ARGS[@]}"
