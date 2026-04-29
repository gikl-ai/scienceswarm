#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# Desktop installers should stay small and reproducible: model weights are
# pulled by the local runtime setup instead of being embedded in the package.
export SCIENCESWARM_DEFAULT_OLLAMA_MODEL="${SCIENCESWARM_DEFAULT_OLLAMA_MODEL:-gemma4:e4b}"

echo "ScienceSwarm desktop runtime setup will download ${SCIENCESWARM_DEFAULT_OLLAMA_MODEL} with Ollama when needed."
echo "Set SCIENCESWARM_SKIP_MODEL_PULL=1 to leave model download to the in-app setup flow."
echo "Set SCIENCESWARM_SKIP_OPENHANDS_PULL=1 to leave the OpenHands image download to /setup."

exec bash "$SCRIPT_DIR/install-runtime-prereqs.sh"
