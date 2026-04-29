#!/bin/bash
set -eo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

MODEL="${OLLAMA_MODEL:-${SCIENCESWARM_DEFAULT_OLLAMA_MODEL:-gemma4:e4b}}"
MODEL="${MODEL#ollama/}"
MODEL="${MODEL#openai/}"
OPENHANDS_IMAGE="${OPENHANDS_IMAGE:-docker.openhands.dev/openhands/openhands@sha256:5c0dc26f467bf8e47a6e76308edb7a30af4084b17e23a3460b5467008b12111b}"

if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
else
  OS="other"
fi

HOST_ARCH="$(uname -m 2>/dev/null || echo unknown)"
if [ "$OS" = "macos" ] && [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
  HOST_ARCH="arm64"
fi

info() {
  echo -e "  ${CYAN}•${NC} $1"
}

ok() {
  echo -e "  ${GREEN}✓${NC} $1"
}

warn() {
  echo -e "  ${YELLOW}⚠${NC} $1"
}

first_executable() {
  for candidate in "$@"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_docker() {
  local from_path
  from_path="$(command -v docker 2>/dev/null || true)"
  first_executable \
    "$from_path" \
    "/usr/local/bin/docker" \
    "/opt/homebrew/bin/docker" \
    "/Applications/Docker.app/Contents/Resources/bin/docker" \
    "/usr/bin/docker"
}

resolve_ollama() {
  local from_path
  from_path="$(command -v ollama 2>/dev/null || true)"
  first_executable \
    "$from_path" \
    "/opt/homebrew/bin/ollama" \
    "/usr/local/bin/ollama" \
    "/Applications/Ollama.app/Contents/Resources/ollama" \
    "/usr/bin/ollama"
}

resolve_brew() {
  local from_path
  from_path="$(command -v brew 2>/dev/null || true)"
  if [ "$OS" = "macos" ] && [ "$HOST_ARCH" = "arm64" ]; then
    case "$from_path" in
      /opt/homebrew/*) first_executable "$from_path" "/opt/homebrew/bin/brew" ;;
      *) first_executable "/opt/homebrew/bin/brew" ;;
    esac
    return $?
  fi
  if [ "$OS" = "macos" ] && [ "$HOST_ARCH" = "x86_64" ]; then
    case "$from_path" in
      /opt/homebrew/*) first_executable "/usr/local/bin/brew" ;;
      *) first_executable "$from_path" "/usr/local/bin/brew" ;;
    esac
    return $?
  fi
  first_executable "$from_path" "/opt/homebrew/bin/brew" "/usr/local/bin/brew"
}

wait_for_docker() {
  local docker_bin="$1"
  local max_wait="${2:-180}"
  local elapsed=0
  until "$docker_bin" info >/dev/null 2>&1; do
    if [ "$elapsed" -ge "$max_wait" ]; then
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

wait_for_ollama() {
  local ollama_bin="$1"
  local max_wait="${2:-90}"
  local elapsed=0
  until "$ollama_bin" list >/dev/null 2>&1; do
    if [ "$elapsed" -ge "$max_wait" ]; then
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

truthy_env() {
  case "$(printf '%s' "${1:-false}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

skip_runtime_downloads() {
  truthy_env "${SCIENCESWARM_SKIP_RUNTIME_DOWNLOADS:-false}"
}

skip_model_pull() {
  skip_runtime_downloads || truthy_env "${SCIENCESWARM_SKIP_MODEL_PULL:-false}"
}

skip_openhands_pull() {
  skip_runtime_downloads || truthy_env "${SCIENCESWARM_SKIP_OPENHANDS_PULL:-false}"
}

install_docker_if_missing() {
  if resolve_docker >/dev/null 2>&1; then
    return 0
  fi

  if [ "$OS" = "macos" ]; then
    local brew_bin
    brew_bin="$(resolve_brew || true)"
    if [ -z "$brew_bin" ]; then
      warn "Docker Desktop is missing and Homebrew was not found. Install Docker Desktop from https://docker.com/products/docker-desktop."
      return 0
    fi
    info "Installing Docker Desktop with Homebrew"
    "$brew_bin" install --cask docker || {
      warn "Docker Desktop install failed. Open /setup after installing Docker Desktop manually."
      return 0
    }
    return 0
  fi

  if [ "$OS" = "linux" ]; then
    warn "Docker is missing. Install Docker Engine from your distribution packages or https://docs.docker.com/engine/install/, start the daemon, then rerun /setup."
  fi
}

start_docker_if_needed() {
  local docker_bin="$1"
  if "$docker_bin" info >/dev/null 2>&1; then
    return 0
  fi

  if [ "$OS" = "macos" ]; then
    info "Starting Docker Desktop"
    open -ga Docker >/dev/null 2>&1 || true
  elif [ "$OS" = "linux" ]; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl start docker >/dev/null 2>&1 || true
    fi
    if ! "$docker_bin" info >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      sudo systemctl start docker >/dev/null 2>&1 || true
      sudo service docker start >/dev/null 2>&1 || true
    fi
  fi

  wait_for_docker "$docker_bin" 180 || {
    if [ "$OS" = "macos" ]; then
      warn "Docker is installed but the daemon is not ready. Open Docker Desktop and rerun /setup."
    else
      warn "Docker is installed but the daemon is not ready. Start the Docker daemon and rerun /setup."
    fi
    return 1
  }
}

ensure_docker_runtime() {
  install_docker_if_missing
  local docker_bin
  docker_bin="$(resolve_docker || true)"
  if [ -z "$docker_bin" ]; then
    return 0
  fi

  start_docker_if_needed "$docker_bin" || return 0
  if skip_openhands_pull; then
    warn "Skipping OpenHands image download because SCIENCESWARM_SKIP_OPENHANDS_PULL is set."
    ok "Docker runtime ready"
    return 0
  fi
  info "Pulling OpenHands image"
  "$docker_bin" pull "$OPENHANDS_IMAGE" >/dev/null || warn "OpenHands image pull failed; /setup can retry it."
  ok "Docker runtime ready"
}

install_ollama_if_missing() {
  if resolve_ollama >/dev/null 2>&1; then
    return 0
  fi

  if [ "$OS" = "macos" ]; then
    local brew_bin
    brew_bin="$(resolve_brew || true)"
    if [ -z "$brew_bin" ]; then
      warn "Ollama is missing and Homebrew was not found. Install Ollama from https://ollama.com/download."
      return 0
    fi
    info "Installing Ollama with Homebrew"
    "$brew_bin" install ollama || warn "Ollama install failed."
    return 0
  fi

  if [ "$OS" = "linux" ]; then
    warn "Ollama is missing. Install it from https://ollama.com/download or your distribution packages, start the daemon, then rerun /setup."
  fi
}

start_ollama_if_needed() {
  local ollama_bin="$1"
  if "$ollama_bin" list >/dev/null 2>&1; then
    return 0
  fi

  if [ "$OS" = "macos" ]; then
    open -ga Ollama >/dev/null 2>&1 || true
    local brew_bin
    brew_bin="$(resolve_brew || true)"
    if [ -n "$brew_bin" ]; then
      "$brew_bin" services start ollama >/dev/null 2>&1 || true
    fi
  elif [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user start ollama >/dev/null 2>&1 || true
  fi

  if ! wait_for_ollama "$ollama_bin" 30; then
    nohup "$ollama_bin" serve >/tmp/scienceswarm-ollama-serve.log 2>&1 &
    wait_for_ollama "$ollama_bin" 90 || {
      warn "Ollama is installed but the daemon is not ready. Start Ollama and rerun /setup."
      return 1
    }
  fi
}

ensure_ollama_runtime() {
  install_ollama_if_missing
  local ollama_bin
  ollama_bin="$(resolve_ollama || true)"
  if [ -z "$ollama_bin" ]; then
    return 0
  fi

  start_ollama_if_needed "$ollama_bin" || return 0
  if "$ollama_bin" list | awk -v target="$MODEL" '
    NR == 1 { next }
    $1 == target { found = 1 }
    # Keep the Gemma 4 alias rows in sync with OLLAMA_RECOMMENDED_MODEL_ALIASES
    # in src/lib/ollama-constants.ts.
    target == "gemma4:e4b" && ($1 == "gemma4" || $1 == "gemma4:latest") { found = 1 }
    (target == "gemma4" || target == "gemma4:latest") && ($1 == "gemma4:e4b" || $1 == "gemma4" || $1 == "gemma4:latest") { found = 1 }
    END { exit found ? 0 : 1 }
  '; then
    ok "Ollama model ready: $MODEL"
    return 0
  fi
  if skip_model_pull; then
    warn "Skipping $MODEL download because SCIENCESWARM_SKIP_MODEL_PULL is set."
    return 0
  fi
  info "Downloading $MODEL with Ollama"
  "$ollama_bin" pull "$MODEL" || warn "Model pull failed; /setup can retry it."
}

echo ""
echo -e "${CYAN}Installing local runtime prerequisites…${NC}"
ensure_docker_runtime
ensure_ollama_runtime
