#!/bin/bash
set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CLI_BIN_DIR="${SCIENCESWARM_BIN_DIR:-$HOME/.local/bin}"

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
  echo -e "  ${YELLOW}⚠${NC}  WSL detected: $label is under $path_value"
  echo "     ScienceSwarm is faster when the repo and data live in the Linux filesystem"
  echo "     (for example ~/scienceswarm and ~/.scienceswarm) instead of /mnt/c/..."
}

is_scienceswarm_checkout() {
  local dir="$1"
  [ -f "$dir/package.json" ] \
    && [ -f "$dir/install.sh" ] \
    && grep -q '"name"[[:space:]]*:[[:space:]]*"scienceswarm"' "$dir/package.json" 2>/dev/null
}

if is_scienceswarm_checkout "$SCRIPT_DIR"; then
  INSTALL_DIR="$SCRIPT_DIR"
else
  INSTALL_DIR="${SCIENCESWARM_INSTALL_DIR:-$HOME/scienceswarm}"
fi

# Detect OS early for friendlier error messages.
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
else
  echo -e "${RED}Unsupported OS: $OSTYPE${NC}"
  exit 1
fi

echo ""
echo -e "${CYAN}🔬 ScienceSwarm Installer${NC}"
echo -e "${CYAN}========================${NC}"
echo "One-screen setup — we do the rest in the browser."
echo ""

# Node
if ! command -v node &>/dev/null; then
  echo -e "  ${YELLOW}⚠${NC}  Node.js not found. Installing…"
  if [[ "$OS" == "macos" ]] && command -v brew &>/dev/null; then
    brew install node
  else
    curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts
  fi
fi
echo -e "  ${GREEN}✓${NC} Node $(node -v)"

# Clone or reuse checkout
if [ ! -d "$INSTALL_DIR" ]; then
  echo -e "${CYAN}Cloning ScienceSwarm…${NC}"
  git clone https://github.com/gikl-ai/scienceswarm.git "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

if is_wsl; then
  warn_wsl_path "Install directory" "$INSTALL_DIR"
  warn_wsl_path "SCIENCESWARM_DIR" "${SCIENCESWARM_DIR:-}"
  warn_wsl_path "BRAIN_ROOT" "${BRAIN_ROOT:-}"
fi

install_scienceswarm_cli() {
  if ! mkdir -p "$CLI_BIN_DIR" || ! ln -sf "$INSTALL_DIR/scienceswarm" "$CLI_BIN_DIR/scienceswarm"; then
    echo -e "  ${YELLOW}⚠${NC}  Could not install CLI shim at $CLI_BIN_DIR/scienceswarm; use ./scienceswarm from $INSTALL_DIR instead."
    return 1
  fi
}

cli_bin_on_path() {
  case ":$PATH:" in
    *":$CLI_BIN_DIR:"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Install deps
echo -e "${CYAN}Installing dependencies…${NC}"
npm install --silent

# Install/start heavyweight local runtimes from the terminal when possible.
# The browser setup route repeats these checks, so this is an early
# convenience pass rather than the single source of truth.
if [ "${SCIENCESWARM_SKIP_RUNTIME_INSTALL:-}" != "1" ] && [ -f scripts/install-runtime-prereqs.sh ]; then
  bash scripts/install-runtime-prereqs.sh || true
fi

# Seed .env
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

CLI_SHIM_INSTALLED=false
if install_scienceswarm_cli; then
  CLI_SHIM_INSTALLED=true
fi

FRONTEND_PORT="${FRONTEND_PORT:-3001}"

echo ""
echo -e "${GREEN}══════════════════════════════════════${NC}"
echo -e "${GREEN}  Ready. Finishing setup in the browser.${NC}"
echo -e "${GREEN}══════════════════════════════════════${NC}"
echo ""
echo "    ./scienceswarm start"
if [ "$CLI_SHIM_INSTALLED" = "true" ] && cli_bin_on_path; then
  echo "    or scienceswarm start"
fi
echo "    The browser opens automatically when the frontend is ready."
echo "    To open setup directly: ./scienceswarm start --open setup"
echo "    Manual setup URL: http://127.0.0.1:${FRONTEND_PORT}/setup"
echo ""
if [ "$CLI_SHIM_INSTALLED" = "true" ] && cli_bin_on_path; then
  echo "  CLI installed at $CLI_BIN_DIR/scienceswarm"
elif [ "$CLI_SHIM_INSTALLED" = "true" ]; then
  echo "  CLI installed at $CLI_BIN_DIR/scienceswarm"
  echo "  Add $CLI_BIN_DIR to PATH if you want to run \`scienceswarm …\` from any shell."
else
  echo "  CLI shim not installed globally; use ./scienceswarm from $INSTALL_DIR"
  echo "  or set SCIENCESWARM_BIN_DIR to a writable directory and rerun install.sh."
fi
echo ""
echo "  The browser setup verifies OpenClaw, OpenHands, Ollama + Gemma,"
echo "  and your Telegram bot, retrying anything the terminal pass could not finish."
