# Desktop Installer Release Checklist

ScienceSwarm desktop installers are built by the **Desktop Installers** GitHub
Actions workflow. The workflow produces unsigned artifacts for:

- macOS DMG
- Windows NSIS `.exe`
- Linux AppImage

The installers do not bundle local model weights or the OpenHands runtime image.
Setup downloads the selected Ollama model on first run, defaulting to
`gemma4:e4b` with `gemma4:e2b` as the lower-memory option.

## Runtime Download Controls

Keep installer artifacts model-free and image-free. Runtime setup downloads
model weights with Ollama and pulls the OpenHands image after install, which
keeps DMG, NSIS, and AppImage artifacts small and lets users choose the right
model for their machine.

The desktop runtime setup entrypoint is:

```bash
npm run desktop:install-runtime
```

Useful overrides:

```bash
SCIENCESWARM_DEFAULT_OLLAMA_MODEL=gemma4:e2b npm run desktop:install-runtime
OLLAMA_MODEL=gemma4:26b npm run desktop:install-runtime
SCIENCESWARM_SKIP_RUNTIME_DOWNLOADS=1 npm run desktop:install-runtime
SCIENCESWARM_SKIP_MODEL_PULL=1 npm run desktop:install-runtime
SCIENCESWARM_SKIP_OPENHANDS_PULL=1 npm run desktop:install-runtime
```

- `SCIENCESWARM_DEFAULT_OLLAMA_MODEL` changes the installer default when
  `OLLAMA_MODEL` is not set.
- `OLLAMA_MODEL` selects the exact Ollama model tag to pull.
- `SCIENCESWARM_SKIP_RUNTIME_DOWNLOADS=1` installs and starts prerequisites
  but leaves both model and OpenHands image downloads to the in-app setup flow.
- `SCIENCESWARM_SKIP_MODEL_PULL=1` installs and starts prerequisites but leaves
  model download to the in-app setup flow.
- `SCIENCESWARM_SKIP_OPENHANDS_PULL=1` installs and starts Docker but leaves the
  OpenHands image download to the in-app setup flow.

## Build

Run the workflow manually from GitHub Actions, or push a `v*` tag. Each matrix
job runs:

```bash
npm ci
npm run build:standalone
npm run desktop:pack:mac      # macOS runner
npm run desktop:pack:win      # Windows runner
npm run desktop:pack:linux    # Linux runner
npm run desktop:checksums
```

The workflow uploads the platform installer plus `SHA256SUMS.txt`.

For `v*` tag builds, each matrix job also uploads its installer assets to the
matching GitHub Release. If the tag does not already have a release, the
workflow creates a draft release first. Release checksum assets are named by
platform, such as `SHA256SUMS-macos.txt`, so macOS, Windows, and Linux jobs do
not overwrite each other. Keep that draft unpublished until the checksums,
release notes, and unsigned-installer caveats are reviewed.

## Signing And Notarization

Installer builds are unsigned unless signing is explicitly required. Keep
unsigned release candidates clearly labeled in release notes and download
instructions.

Set this repository or workflow environment variable to fail the build when a
platform signing environment is incomplete:

```bash
SCIENCESWARM_REQUIRE_DESKTOP_SIGNING=1
```

The signing preflight can also be run locally for a specific target:

```bash
SCIENCESWARM_REQUIRE_DESKTOP_SIGNING=1 \
SCIENCESWARM_DESKTOP_SIGNING_TARGET=macos \
npm run desktop:check-signing-env
```

Accepted `SCIENCESWARM_DESKTOP_SIGNING_TARGET` values are `macos`, `windows`,
and `linux`.

Required signing secrets by platform:

- macOS requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
  and either `CSC_LINK` plus `CSC_KEY_PASSWORD` or `MAC_CSC_LINK` plus
  `MAC_CSC_KEY_PASSWORD`.
- Windows requires either `WIN_CSC_LINK` plus `WIN_CSC_KEY_PASSWORD` or the
  shared `CSC_LINK` plus `CSC_KEY_PASSWORD` pair.
- Linux AppImage builds do not require signing secrets today.

For macOS releases, keep notarization enabled only when the Apple account and
certificate secrets are present. If the workflow is intentionally run without
signing, publish the unsigned artifacts as test builds rather than production
installers.

## Verify Downloads

After downloading an artifact bundle, verify the checksum manifest before
opening the installer:

```bash
shasum -a 256 -c SHA256SUMS.txt   # macOS
sha256sum -c SHA256SUMS.txt       # Linux
```

On Windows PowerShell, compare the manifest entry with:

```powershell
Get-Item .\ScienceSwarm-*.exe | Get-FileHash -Algorithm SHA256
```

## Release Notes

Before publishing a release, confirm:

- The workflow run used the intended commit or tag.
- All three platform jobs completed successfully.
- `SHA256SUMS.txt` is present in each uploaded artifact bundle, and each release
  asset set has the platform-specific checksum file.
- The release notes state that installers are unsigned unless signing and
  notarization have been added for that release.
- The release notes state that local model weights and the OpenHands image are
  downloaded during setup, not shipped inside the installer.
