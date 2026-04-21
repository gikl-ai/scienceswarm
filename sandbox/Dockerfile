# scienceswarm/sandbox:latest
#
# Custom sandbox image that OpenHands 1.6 drives during audit-revise runs.
#
# OpenHands 1.6 sandboxes are actually `agent-server` processes: they serve
# an HTTP API the conversation orchestrator calls. We therefore MUST build
# FROM the upstream agent-server base so the contract OpenHands expects
# (port 8000 HTTP surface, workspace conventions, entrypoint) stays intact.
# We layer on the tools the audit-revise job definitions need.
#
# Job kinds this image serves:
#   - revise_paper                        (src/lib/jobs/definitions/revise_paper.md)
#   - rerun_stats_and_regenerate_figure   (src/lib/jobs/definitions/rerun_stats_and_regenerate_figure.md)
#
# Explicitly out of scope for v1:
#   - translate_paper     (needs argostranslate / language packs)
#   - write_cover_letter  (not yet plumbed end-to-end)
#
# The sandbox MUST NOT open its own PGLite connection against the host
# gbrain store. PR #301 fixed a lock conflict caused by exactly that.
# Instead the sandbox talks to the host Next.js server
# (http://host.docker.internal:3001) via the tiny `gbrain` HTTP shim
# installed below.
#
# OpenHands 1.6 resolves the sandbox image via AGENT_SERVER_IMAGE_REPOSITORY
# + AGENT_SERVER_IMAGE_TAG on the main openhands container (the old 1.5
# `SANDBOX_BASE_CONTAINER_IMAGE` contract no longer applies). See
# docker-compose.yml for the current wiring.

FROM ghcr.io/openhands/agent-server:1.15.0-python

# Agent-server is Debian 13 with Python 3.13. `patch` is already
# installed; we add TeX Live for pdflatex and nothing else apt-wise.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-recommended \
      texlive-fonts-recommended \
      texlive-latex-extra \
 && rm -rf /var/lib/apt/lists/*

# Python packages:
#   numpy/scipy  — scipy chi-square baseline for rerun_stats
#   pymc         — Beta-Binomial / Dirichlet-Multinomial posterior fit
#   matplotlib   — Figure 1 regeneration
#   pandas       — CSV parsing convenience
#   requests     — HTTP client for the gbrain wrapper
# Pinned minimums so a stale apt cache can't silently downgrade us.
RUN pip install --no-cache-dir --break-system-packages \
      "numpy>=2.0" \
      "scipy>=1.13" \
      "pymc>=5.16" \
      "matplotlib>=3.9" \
      "pandas>=2.2" \
      "requests>=2.32"

# Install the HTTP shim that mirrors the subset of the real gbrain CLI
# surface the job definitions actually call. Build context is the repo
# root so this path resolves to the checked-in wrapper at
# sandbox/bin/gbrain.
COPY sandbox/bin/gbrain /usr/local/bin/gbrain
RUN chmod +x /usr/local/bin/gbrain

# Do NOT override ENTRYPOINT / CMD / WORKDIR. OpenHands drives the
# container with the upstream agent-server entrypoint; overriding them
# would leave the container running but with no HTTP surface on 8000,
# and OpenHands would hang waiting to talk to a non-existent agent.
