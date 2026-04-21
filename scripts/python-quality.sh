#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

RUFF_VERSION="0.15.9"
TY_VERSION="0.0.29"

declare -a targets=()
declare -a ty_targets=()

add_target() {
  local path="$1"
  targets+=("$path")
  case "$path" in
    tests/fixtures/*) ;;
    *) ty_targets+=("$path") ;;
  esac
}

if (($# > 0)); then
  for path in "$@"; do
    if [[ -f "$path" ]]; then
      case "$path" in
        *.py|*.pyi) add_target "$path" ;;
      esac
    fi
  done
else
  while IFS= read -r path; do
    add_target "$path"
  done < <(git ls-files '*.py' '*.pyi')
fi

if (( ${#targets[@]} == 0 )); then
  echo "No tracked Python files. Skipping Ruff and ty."
  exit 0
fi

ty_args=()
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  ty_args+=(--output-format github)
fi

uvx "ruff@${RUFF_VERSION}" format --check "${targets[@]}"
uvx "ruff@${RUFF_VERSION}" check "${targets[@]}"
if (( ${#ty_targets[@]} == 0 )); then
  echo "No non-fixture Python files. Skipping ty."
elif (( ${#ty_args[@]} > 0 )); then
  uvx "ty@${TY_VERSION}" check "${ty_args[@]}" "${ty_targets[@]}"
else
  uvx "ty@${TY_VERSION}" check "${ty_targets[@]}"
fi
